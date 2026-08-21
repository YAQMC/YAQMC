// QMC key derivation and segmented stream cipher independently adapt
// QMCDecode (MIT). See THIRD_PARTY_NOTICES.md.

use base64::{engine::general_purpose::STANDARD, Engine as _};
#[cfg(test)]
use std::io::{Read, Seek, SeekFrom};
use std::{fmt, io, sync::Arc};
use thiserror::Error;
use yaqmc_provider_api::{EncryptedMedia, MediaDecryptor, PlaybackSourceError};
use zeroize::{Zeroize, Zeroizing};

const FIRST_SEGMENT_SIZE: usize = 128;
const SEGMENT_SIZE: usize = 5_120;
const V2_PREFIX: &[u8] = b"QQMusic EncV2,Key:";
const V2_MIX_KEY_ONE: [u8; 16] = [
    0x33, 0x38, 0x36, 0x5a, 0x4a, 0x59, 0x21, 0x40, 0x23, 0x2a, 0x24, 0x25, 0x5e, 0x26, 0x29, 0x28,
];
const V2_MIX_KEY_TWO: [u8; 16] = [
    0x2a, 0x2a, 0x23, 0x21, 0x28, 0x23, 0x24, 0x25, 0x26, 0x5e, 0x61, 0x31, 0x63, 0x5a, 0x2c, 0x54,
];

#[derive(Clone)]
pub struct EncryptedMediaKey(Zeroizing<String>);

impl EncryptedMediaKey {
    pub fn new(value: String) -> Result<Self, QmcError> {
        let value = value.trim();
        if value.is_empty() || value.len() > 16 * 1_024 {
            return Err(QmcError::InvalidKey);
        }
        Ok(Self(Zeroizing::new(value.to_owned())))
    }
    pub(crate) fn expose(&self) -> &str {
        self.0.as_str()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn is_v2(&self) -> bool {
        self.0.as_str().starts_with("QQMusic EncV2,Key:")
    }
}

impl fmt::Debug for EncryptedMediaKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("EncryptedMediaKey([REDACTED])")
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum QmcError {
    #[error("the encrypted media key is invalid")]
    InvalidKey,
    #[error("the encrypted media key is not valid base64")]
    KeyNotBase64,
    #[error("the encrypted media key has an invalid EncV2 wrapper")]
    InvalidV2Wrapper,
    #[error("the derived key has an invalid length")]
    InvalidDerivedKeyLength,
    #[error("the TEA padding check failed while deriving the key")]
    TeaPaddingMismatch,
    #[error("the media cipher key is empty")]
    EmptyCipherKey,
}

enum QmcCipher {
    Map(MapCipher),
    Rc4(Rc4Cipher),
}

#[derive(Clone)]
#[doc(hidden)]
pub struct QmcDecryptor(Arc<QmcCipher>);

impl QmcDecryptor {
    pub(crate) fn new(ekey: &EncryptedMediaKey) -> Result<Self, QmcError> {
        let expose = ekey.expose();
        let key = derive_key(expose)?;
        let cipher = if key.len() > 300 {
            QmcCipher::Rc4(Rc4Cipher::new(key)?)
        } else {
            QmcCipher::Map(MapCipher::new(key)?)
        };
        tracing::info!(
            target: "qmc",
            ekey_length = expose.len(),
            ekey_v2 = expose.starts_with("QQMusic EncV2,Key:"),
            derived_key_length = key_len_hint(&cipher),
            cipher = if matches!(cipher, QmcCipher::Rc4(_)) {
                "rc4"
            } else {
                "map"
            },
            "constructed QMC stream decryptor"
        );
        Ok(Self(Arc::new(cipher)))
    }

    fn decrypt(&self, data: &mut [u8], offset: u64) -> io::Result<()> {
        let offset = usize::try_from(offset)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "QMC offset is too large"))?;
        self.0.decrypt(data, offset);
        Ok(())
    }

    pub(crate) fn cipher_kind(&self) -> &'static str {
        match self.0.as_ref() {
            QmcCipher::Map(_) => "map",
            QmcCipher::Rc4(_) => "rc4",
        }
    }

    pub(crate) fn derived_key_length(&self) -> usize {
        key_len_hint(&self.0)
    }
}

fn key_len_hint(cipher: &QmcCipher) -> usize {
    match cipher {
        QmcCipher::Map(MapCipher { key }) | QmcCipher::Rc4(Rc4Cipher { key, .. }) => key.len(),
    }
}

impl fmt::Debug for QmcDecryptor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("QmcDecryptor([REDACTED])")
    }
}

impl MediaDecryptor for QmcDecryptor {
    fn decrypt(&self, data: &mut [u8], offset: u64) -> io::Result<()> {
        QmcDecryptor::decrypt(self, data, offset)
    }

    fn cipher_kind(&self) -> &'static str {
        QmcDecryptor::cipher_kind(self)
    }

    fn derived_key_length(&self) -> usize {
        QmcDecryptor::derived_key_length(self)
    }
}

impl EncryptedMedia for EncryptedMediaKey {
    fn key_len(&self) -> usize {
        self.len()
    }

    fn key_is_v2(&self) -> bool {
        self.is_v2()
    }

    fn create_decryptor(&self) -> Result<Arc<dyn MediaDecryptor>, PlaybackSourceError> {
        // Synthetic vectors match the pinned library. Keep the in-tree
        // decryptor until row J also passes a real-file golden.
        QmcDecryptor::new(self)
            .map(|decryptor| Arc::new(decryptor) as Arc<dyn MediaDecryptor>)
            .map_err(|_| PlaybackSourceError::DecryptionFailed)
    }
}

#[cfg(test)]
struct QmcReader<Reader> {
    inner: Reader,
    decryptor: QmcDecryptor,
    position: u64,
}

#[cfg(test)]
impl<Reader> QmcReader<Reader> {
    fn new(inner: Reader, decryptor: QmcDecryptor) -> Self {
        Self {
            inner,
            decryptor,
            position: 0,
        }
    }
}

#[cfg(test)]
impl<Reader: Read> Read for QmcReader<Reader> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.decryptor.decrypt(&mut buffer[..read], self.position)?;
        self.position = self.position.saturating_add(read as u64);
        Ok(read)
    }
}

#[cfg(test)]
impl<Reader: Seek> Seek for QmcReader<Reader> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.position = self.inner.seek(position)?;
        Ok(self.position)
    }
}

impl QmcCipher {
    #[cfg(test)]
    fn from_ekey(ekey: &EncryptedMediaKey) -> Result<Self, QmcError> {
        let key = derive_key(ekey.expose())?;
        if key.len() > 300 {
            Ok(Self::Rc4(Rc4Cipher::new(key)?))
        } else {
            Ok(Self::Map(MapCipher::new(key)?))
        }
    }

    fn decrypt(&self, data: &mut [u8], offset: usize) {
        match self {
            Self::Map(cipher) => cipher.decrypt(data, offset),
            Self::Rc4(cipher) => cipher.decrypt(data, offset),
        }
    }
}

fn derive_key(raw_key: &str) -> Result<Zeroizing<Vec<u8>>, QmcError> {
    let mut decoded = Zeroizing::new(
        STANDARD
            .decode(raw_key.trim())
            .map_err(|_| QmcError::KeyNotBase64)?,
    );
    if let Some(encrypted_v2) = decoded.strip_prefix(V2_PREFIX) {
        let first_pass = decrypt_tencent_tea(encrypted_v2, &V2_MIX_KEY_ONE)?;
        let second_pass = decrypt_tencent_tea(&first_pass, &V2_MIX_KEY_TWO)?;
        decoded = Zeroizing::new(
            STANDARD
                .decode(&second_pass)
                .map_err(|_| QmcError::InvalidV2Wrapper)?,
        );
    }
    if decoded.len() < 24 || (decoded.len() - 8) % 8 != 0 {
        return Err(QmcError::InvalidDerivedKeyLength);
    }

    let simple_key = simple_make_key(106);
    let mut tea_key = Zeroizing::new([0_u8; 16]);
    for index in 0..8 {
        tea_key[index * 2] = simple_key[index];
        tea_key[index * 2 + 1] = decoded[index];
    }
    let decrypted = decrypt_tencent_tea(&decoded[8..], &tea_key)?;
    decoded.truncate(8);
    decoded.extend_from_slice(&decrypted);
    Ok(decoded)
}

fn simple_make_key(seed: u8) -> [u8; 8] {
    std::array::from_fn(|index| ((f64::from(seed) + index as f64 * 0.1).tan().abs() * 100.0) as u8)
}

fn decrypt_tencent_tea(input: &[u8], key: &[u8; 16]) -> Result<Zeroizing<Vec<u8>>, QmcError> {
    const SALT_LENGTH: usize = 2;
    const ZERO_LENGTH: usize = 7;
    if input.len() < 16 || !input.len().is_multiple_of(8) {
        return Err(QmcError::InvalidV2Wrapper);
    }

    let tea_key = [
        u32::from_be_bytes(
            key[0..4]
                .try_into()
                .map_err(|_| QmcError::InvalidV2Wrapper)?,
        ),
        u32::from_be_bytes(
            key[4..8]
                .try_into()
                .map_err(|_| QmcError::InvalidV2Wrapper)?,
        ),
        u32::from_be_bytes(
            key[8..12]
                .try_into()
                .map_err(|_| QmcError::InvalidV2Wrapper)?,
        ),
        u32::from_be_bytes(
            key[12..16]
                .try_into()
                .map_err(|_| QmcError::InvalidV2Wrapper)?,
        ),
    ];
    let mut block = tea_decrypt_block(&input[..8], &tea_key)?;
    let padding = usize::from(block[0] & 0x07);
    let Some(output_length) = input
        .len()
        .checked_sub(1 + padding + SALT_LENGTH + ZERO_LENGTH)
    else {
        return Err(QmcError::InvalidV2Wrapper);
    };
    let mut output = Zeroizing::new(vec![0_u8; output_length]);
    let mut previous_cipher = [0_u8; 8];
    let mut current_cipher: [u8; 8] = input[..8]
        .try_into()
        .map_err(|_| QmcError::InvalidV2Wrapper)?;
    let mut input_position = 8_usize;
    let mut block_position = 1 + padding;

    let advance_block = |block: &mut [u8; 8],
                         previous_cipher: &mut [u8; 8],
                         current_cipher: &mut [u8; 8],
                         input_position: &mut usize|
     -> Result<(), QmcError> {
        let end = input_position
            .checked_add(8)
            .filter(|end| *end <= input.len())
            .ok_or(QmcError::InvalidV2Wrapper)?;
        *previous_cipher = *current_cipher;
        *current_cipher = input[*input_position..end]
            .try_into()
            .map_err(|_| QmcError::InvalidV2Wrapper)?;
        for (byte, cipher) in block.iter_mut().zip(current_cipher.iter()) {
            *byte ^= *cipher;
        }
        *block = tea_decrypt_block(block, &tea_key)?;
        *input_position = end;
        Ok(())
    };

    for _ in 0..SALT_LENGTH {
        if block_position == 8 {
            advance_block(
                &mut block,
                &mut previous_cipher,
                &mut current_cipher,
                &mut input_position,
            )?;
            block_position = 0;
        }
        block_position += 1;
    }

    for output_byte in output.iter_mut() {
        if block_position == 8 {
            advance_block(
                &mut block,
                &mut previous_cipher,
                &mut current_cipher,
                &mut input_position,
            )?;
            block_position = 0;
        }
        *output_byte = block[block_position] ^ previous_cipher[block_position];
        block_position += 1;
    }

    for _ in 0..ZERO_LENGTH {
        if block_position == 8 {
            advance_block(
                &mut block,
                &mut previous_cipher,
                &mut current_cipher,
                &mut input_position,
            )?;
            block_position = 0;
        }
        if block[block_position] != previous_cipher[block_position] {
            return Err(QmcError::TeaPaddingMismatch);
        }
        block_position += 1;
    }
    block.zeroize();
    current_cipher.zeroize();
    previous_cipher.zeroize();
    Ok(output)
}

fn tea_decrypt_block(input: &[u8], key: &[u32; 4]) -> Result<[u8; 8], QmcError> {
    if input.len() != 8 {
        return Err(QmcError::InvalidV2Wrapper);
    }
    let mut left = u32::from_be_bytes(
        input[..4]
            .try_into()
            .map_err(|_| QmcError::InvalidV2Wrapper)?,
    );
    let mut right = u32::from_be_bytes(
        input[4..]
            .try_into()
            .map_err(|_| QmcError::InvalidV2Wrapper)?,
    );
    let delta = 0x9e37_79b9_u32;
    let mut sum = delta.wrapping_mul(16);
    for _ in 0..16 {
        right = right.wrapping_sub(
            ((left << 4).wrapping_add(key[2]))
                ^ left.wrapping_add(sum)
                ^ ((left >> 5).wrapping_add(key[3])),
        );
        left = left.wrapping_sub(
            ((right << 4).wrapping_add(key[0]))
                ^ right.wrapping_add(sum)
                ^ ((right >> 5).wrapping_add(key[1])),
        );
        sum = sum.wrapping_sub(delta);
    }
    let mut output = [0_u8; 8];
    output[..4].copy_from_slice(&left.to_be_bytes());
    output[4..].copy_from_slice(&right.to_be_bytes());
    Ok(output)
}

struct MapCipher {
    key: Zeroizing<Vec<u8>>,
}

impl MapCipher {
    fn new(key: Zeroizing<Vec<u8>>) -> Result<Self, QmcError> {
        if key.is_empty() {
            return Err(QmcError::EmptyCipherKey);
        }
        Ok(Self { key })
    }

    fn decrypt(&self, data: &mut [u8], offset: usize) {
        for (index, byte) in data.iter_mut().enumerate() {
            let position = offset.saturating_add(index);
            let position = if position > 0x7fff {
                position % 0x7fff
            } else {
                position
            };
            let key_index = position.wrapping_mul(position).wrapping_add(71_214) % self.key.len();
            // Same non-circular mask as QMCDecode QMMapCipher: `(key << rot) | (key >> rot)`,
            // not u8::rotate_left. rot = ((key_index & 7) + 4) % 8.
            let rotate = ((key_index & 7) + 4) % 8;
            let value = self.key[key_index];
            *byte ^= (value << rotate) | (value >> rotate);
        }
    }
}

struct Rc4Cipher {
    key: Zeroizing<Vec<u8>>,
    seed_box: Zeroizing<Vec<u8>>,
    hash: u32,
}

impl Rc4Cipher {
    fn new(key: Zeroizing<Vec<u8>>) -> Result<Self, QmcError> {
        if key.is_empty() {
            return Err(QmcError::EmptyCipherKey);
        }
        let length = key.len();
        let mut seed_box = Zeroizing::new((0..length).map(|index| index as u8).collect::<Vec<_>>());
        let mut right = 0_usize;
        for left in 0..length {
            right = (right + usize::from(seed_box[left]) + usize::from(key[left])) % length;
            seed_box.swap(left, right);
        }
        let mut hash = 1_u32;
        for &value in key.iter() {
            if value == 0 {
                continue;
            }
            let next = hash.wrapping_mul(u32::from(value));
            if next == 0 || next <= hash {
                break;
            }
            hash = next;
        }
        Ok(Self {
            key,
            seed_box,
            hash,
        })
    }

    fn segment_skip(&self, index: usize) -> usize {
        let seed = usize::from(self.key[index % self.key.len()]);
        if seed == 0 {
            return 0;
        }
        ((f64::from(self.hash) / ((index + 1) * seed) as f64 * 100.0) as usize) % self.key.len()
    }

    fn decrypt(&self, data: &mut [u8], offset: usize) {
        let mut processed = 0_usize;
        let mut position = offset;
        if position < FIRST_SEGMENT_SIZE {
            let length = data.len().min(FIRST_SEGMENT_SIZE - position);
            self.decrypt_first(&mut data[..length], position);
            processed += length;
            position += length;
        }
        while processed < data.len() {
            let length = (SEGMENT_SIZE - position % SEGMENT_SIZE).min(data.len() - processed);
            self.decrypt_segment(&mut data[processed..processed + length], position);
            processed += length;
            position += length;
        }
    }

    fn decrypt_first(&self, data: &mut [u8], offset: usize) {
        for (index, byte) in data.iter_mut().enumerate() {
            *byte ^= self.key[self.segment_skip(offset + index)];
        }
    }

    fn decrypt_segment(&self, data: &mut [u8], offset: usize) {
        let mut state = self.seed_box.clone();
        let skip = offset % SEGMENT_SIZE + self.segment_skip(offset / SEGMENT_SIZE);
        let mut left = 0_usize;
        let mut right = 0_usize;
        for stream_index in 0..skip.saturating_add(data.len()) {
            left = (left + 1) % state.len();
            right = (right + usize::from(state[left])) % state.len();
            state.swap(left, right);
            if stream_index >= skip {
                let target = stream_index - skip;
                let key_index =
                    (usize::from(state[left]) + usize::from(state[right])) % state.len();
                data[target] ^= state[key_index];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rodio::Source;
    use std::{fs, fs::File, path::PathBuf};

    fn tea_encrypt_block(input: &[u8; 8], key: &[u8; 16]) -> [u8; 8] {
        let key = [
            u32::from_be_bytes(key[0..4].try_into().expect("key word")),
            u32::from_be_bytes(key[4..8].try_into().expect("key word")),
            u32::from_be_bytes(key[8..12].try_into().expect("key word")),
            u32::from_be_bytes(key[12..16].try_into().expect("key word")),
        ];
        let mut left = u32::from_be_bytes(input[..4].try_into().expect("left word"));
        let mut right = u32::from_be_bytes(input[4..].try_into().expect("right word"));
        let delta = 0x9e37_79b9_u32;
        let mut sum = 0_u32;
        for _ in 0..16 {
            sum = sum.wrapping_add(delta);
            left = left.wrapping_add(
                ((right << 4).wrapping_add(key[0]))
                    ^ right.wrapping_add(sum)
                    ^ ((right >> 5).wrapping_add(key[1])),
            );
            right = right.wrapping_add(
                ((left << 4).wrapping_add(key[2]))
                    ^ left.wrapping_add(sum)
                    ^ ((left >> 5).wrapping_add(key[3])),
            );
        }
        let mut output = [0_u8; 8];
        output[..4].copy_from_slice(&left.to_be_bytes());
        output[4..].copy_from_slice(&right.to_be_bytes());
        output
    }

    fn encrypt_tencent_tea_for_test(body: &[u8], key: &[u8; 16]) -> Vec<u8> {
        let padding = (8 - (body.len() + 10) % 8) % 8;
        let mut plain = Vec::with_capacity(body.len() + padding + 10);
        plain.push(padding as u8);
        plain.extend((0..padding).map(|index| 0xa0_u8.wrapping_add(index as u8)));
        plain.extend_from_slice(&[0x5a, 0xa5]);
        plain.extend_from_slice(body);
        plain.extend_from_slice(&[0_u8; 7]);
        assert!(plain.len().is_multiple_of(8));

        let mut previous_plain = [0_u8; 8];
        let mut previous_cipher = [0_u8; 8];
        let mut output = Vec::with_capacity(plain.len());
        for chunk in plain.chunks_exact(8) {
            let mut mixed = [0_u8; 8];
            for index in 0..8 {
                mixed[index] = chunk[index] ^ previous_cipher[index];
            }
            let encrypted = tea_encrypt_block(&mixed, key);
            let mut cipher = [0_u8; 8];
            for index in 0..8 {
                cipher[index] = encrypted[index] ^ previous_plain[index];
            }
            output.extend_from_slice(&cipher);
            previous_plain = mixed;
            previous_cipher = cipher;
        }
        output
    }

    pub(crate) fn encode_test_ekey(clear_key: &[u8], version_two: bool) -> String {
        assert!(clear_key.len() >= 16);
        let simple_key = simple_make_key(106);
        let mut tea_key = [0_u8; 16];
        for index in 0..8 {
            tea_key[index * 2] = simple_key[index];
            tea_key[index * 2 + 1] = clear_key[index];
        }
        let mut v1 = clear_key[..8].to_vec();
        v1.extend(encrypt_tencent_tea_for_test(&clear_key[8..], &tea_key));
        if !version_two {
            return STANDARD.encode(v1);
        }
        let encoded_v1 = STANDARD.encode(v1);
        let inner = encrypt_tencent_tea_for_test(encoded_v1.as_bytes(), &V2_MIX_KEY_TWO);
        let outer = encrypt_tencent_tea_for_test(&inner, &V2_MIX_KEY_ONE);
        let mut wrapped = V2_PREFIX.to_vec();
        wrapped.extend(outer);
        STANDARD.encode(wrapped)
    }

    fn round_trip(cipher: &QmcCipher) {
        let original = (0..25_123).map(|value| value as u8).collect::<Vec<_>>();
        let mut encrypted = original.clone();
        cipher.decrypt(&mut encrypted, 0);
        assert_ne!(encrypted, original);
        let mut offset = 0_usize;
        for chunk in encrypted.chunks_mut(777) {
            cipher.decrypt(chunk, offset);
            offset += chunk.len();
        }
        assert_eq!(encrypted, original);
    }

    #[test]
    fn map_and_segmented_rc4_are_chunk_boundary_independent() {
        round_trip(&QmcCipher::Map(
            MapCipher::new(Zeroizing::new((1..=128).collect())).expect("map key"),
        ));
        round_trip(&QmcCipher::Rc4(
            Rc4Cipher::new(Zeroizing::new(
                (0..512).map(|value| (value % 251 + 1) as u8).collect(),
            ))
            .expect("rc4 key"),
        ));
    }

    #[test]
    fn invalid_keys_are_rejected_without_exposing_the_value() {
        assert_eq!(
            EncryptedMediaKey::new("  ".to_owned()).expect_err("empty key"),
            QmcError::InvalidKey
        );
        let key = EncryptedMediaKey::new("not-secret".to_owned()).expect("bounded key");
        assert_eq!(format!("{key:?}"), "EncryptedMediaKey([REDACTED])");
        assert_eq!(
            QmcCipher::from_ekey(&key).err(),
            Some(QmcError::KeyNotBase64)
        );
    }

    #[test]
    fn version_one_and_version_two_keys_derive_the_same_cipher_key() {
        let clear_key = (0..512)
            .map(|value| (value % 251 + 1) as u8)
            .collect::<Vec<_>>();
        for version_two in [false, true] {
            let encoded = encode_test_ekey(&clear_key, version_two);
            assert_eq!(
                derive_key(&encoded).expect("derive key").as_slice(),
                clear_key
            );
        }
    }

    #[test]
    fn streaming_reader_decrypts_reads_and_seeks_at_absolute_offsets() {
        let clear_key = (0..512)
            .map(|value| (value % 251 + 1) as u8)
            .collect::<Vec<_>>();
        let encoded = encode_test_ekey(&clear_key, true);
        let ekey = EncryptedMediaKey::new(encoded).expect("encoded key");
        let decryptor = QmcDecryptor::new(&ekey).expect("decryptor");
        let original = (0..25_123).map(|value| value as u8).collect::<Vec<_>>();
        let mut encrypted = original.clone();
        decryptor
            .decrypt(&mut encrypted, 0)
            .expect("encrypt fixture");
        let mut reader = QmcReader::new(std::io::Cursor::new(encrypted), decryptor);

        let mut prefix = vec![0_u8; 913];
        reader.read_exact(&mut prefix).expect("read prefix");
        assert_eq!(prefix, original[..913]);
        reader.seek(SeekFrom::Start(12_345)).expect("seek");
        let mut middle = vec![0_u8; 4_321];
        reader.read_exact(&mut middle).expect("read middle");
        assert_eq!(middle, original[12_345..16_666]);
    }

    #[test]
    #[ignore = "requires YAQMC_QMC_SAMPLE and YAQMC_QMC_EKEY_FILE"]
    fn decrypts_external_mflac_sample() {
        let input = PathBuf::from(std::env::var_os("YAQMC_QMC_SAMPLE").expect("sample path"));
        let ekey_path =
            PathBuf::from(std::env::var_os("YAQMC_QMC_EKEY_FILE").expect("ekey file path"));
        let ekey = EncryptedMediaKey::new(
            fs::read_to_string(ekey_path)
                .expect("read external ekey")
                .trim()
                .to_owned(),
        )
        .expect("valid external ekey");
        let decryptor = QmcDecryptor::new(&ekey).expect("valid decryptor");
        let decoder_decryptor = decryptor.clone();
        let directory = tempfile::tempdir().expect("temporary output");
        let output = directory.path().join("sample.flac");
        let mut reader = QmcReader::new(File::open(&input).expect("open sample"), decryptor);
        let mut writer = File::create(&output).expect("create temporary output");
        let bytes = io::copy(&mut reader, &mut writer).expect("stream-decrypt external sample");
        assert_eq!(bytes, input.metadata().expect("sample metadata").len());
        let mut magic = [0_u8; 4];
        File::open(output)
            .expect("open output")
            .read_exact(&mut magic)
            .expect("read FLAC magic");
        assert_eq!(&magic, b"fLaC");

        let reader = QmcReader::new(
            File::open(&input).expect("reopen sample"),
            decoder_decryptor,
        );
        let mut decoder = rodio::decoder::DecoderBuilder::new()
            .with_data(reader)
            .with_byte_len(bytes)
            .with_seekable(true)
            .with_hint("flac")
            .build()
            .expect("streaming reader decodes as FLAC");
        let duration = decoder.total_duration().expect("FLAC duration");
        assert!(duration > std::time::Duration::from_secs(180));
        decoder
            .try_seek(std::time::Duration::from_secs(90))
            .expect("decrypted stream supports random seek");
        assert!(decoder.next().is_some());
    }

    #[cfg(feature = "qmapi")]
    fn intree_and_qmapi_decrypt_match(clear_key: Vec<u8>) -> bool {
        use yaqmc_provider_api::MediaDecryptor as _;

        let encoded = encode_test_ekey(&clear_key, true);
        let ekey = EncryptedMediaKey::new(encoded).expect("encoded key");
        let intree = QmcDecryptor::new(&ekey).expect("intree decryptor");
        let Ok(qmapi) = crate::qmapi::qmc::QmapiQmcDecryptor::new(&ekey) else {
            return false;
        };
        assert_eq!(intree.cipher_kind(), qmapi.cipher_kind());
        assert_eq!(intree.derived_key_length(), qmapi.derived_key_length());
        let original = (0..8_192).map(|value| value as u8).collect::<Vec<_>>();
        let mut intree_bytes = original.clone();
        let mut qmapi_bytes = original;
        intree
            .decrypt(&mut intree_bytes, 0)
            .expect("intree encrypt fixture");
        qmapi
            .decrypt(&mut qmapi_bytes, 0)
            .expect("qmapi encrypt fixture");
        intree_bytes == qmapi_bytes
    }

    #[cfg(feature = "qmapi")]
    #[test]
    fn qmapi_qmc_matches_intree_map_and_rc4() {
        let map_equal = intree_and_qmapi_decrypt_match((1..=128).collect());
        let rc4_equal =
            intree_and_qmapi_decrypt_match((0..512).map(|value| (value % 251 + 1) as u8).collect());
        assert!(map_equal, "P14-B row J: Map cipher output diverged");
        assert!(rc4_equal, "P14-B row J: RC4 cipher output diverged");
    }
}
