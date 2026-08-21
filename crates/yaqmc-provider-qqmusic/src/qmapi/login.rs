//! Row C: library QR types mapped onto in-tree poll states. Production QR and
//! Electron OAuth remain on `auth.rs` during P14-C preparation. Credential
//! persistence lives in `credential.rs`: v2 is primary and `qqmusic-session`
//! remains the synchronized migration/rollback slot until cutover.

use qqmusic_api::models::login::{QRCodeLoginEvents, QR};

pub(crate) struct QmapiQrChallenge {
    pub qr_bytes: Vec<u8>,
    pub mime_type: String,
    pub poll_secret: String,
}

pub(crate) fn qr_challenge_from_library(qr: QR) -> QmapiQrChallenge {
    QmapiQrChallenge {
        qr_bytes: qr.data,
        mime_type: qr.mimetype,
        poll_secret: qr.identifier,
    }
}

pub(crate) fn poll_state_from_library(event: QRCodeLoginEvents) -> &'static str {
    match event {
        QRCodeLoginEvents::Scan => "waiting-for-scan",
        QRCodeLoginEvents::Conf => "waiting-for-confirmation",
        QRCodeLoginEvents::Done => "confirmed",
        QRCodeLoginEvents::Timeout => "expired",
        QRCodeLoginEvents::Refuse => "rejected",
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use qqmusic_api::{
        models::login::{QRCodeLoginEvents, QRLoginType},
        ApiTransport, Client, TransportRequest, TransportResponse,
    };

    use super::*;

    struct QrShowTransport {
        captured: Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl ApiTransport for QrShowTransport {
        async fn execute(
            &self,
            request: TransportRequest,
        ) -> qqmusic_api::Result<TransportResponse> {
            self.captured
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(request.url.clone());
            Ok(TransportResponse {
                status: 200,
                final_url: request.url,
                headers: vec![(
                    "set-cookie".to_owned(),
                    "qrsig=SYNTHETIC_QRSIG; Path=/; HttpOnly".to_owned(),
                )],
                body: b"\x89PNG".to_vec(),
            })
        }
    }

    #[test]
    fn library_qr_events_map_onto_intree_poll_states() {
        assert_eq!(
            poll_state_from_library(QRCodeLoginEvents::Scan),
            "waiting-for-scan"
        );
        assert_eq!(
            poll_state_from_library(QRCodeLoginEvents::Conf),
            "waiting-for-confirmation"
        );
        assert_eq!(
            poll_state_from_library(QRCodeLoginEvents::Done),
            "confirmed"
        );
        assert_eq!(
            poll_state_from_library(QRCodeLoginEvents::Timeout),
            "expired"
        );
        assert_eq!(
            poll_state_from_library(QRCodeLoginEvents::Refuse),
            "rejected"
        );
    }

    #[tokio::test]
    async fn get_qq_qr_uses_injected_transport_and_qrsig_cookie() {
        let transport = std::sync::Arc::new(QrShowTransport {
            captured: Mutex::new(Vec::new()),
        });
        let client = Client::new_with_transport(None, None, transport.clone());
        let qr = client.login.get_qq_qr().await.expect("qr");
        assert_eq!(qr.qr_type, QRLoginType::Qq);
        let challenge = qr_challenge_from_library(qr);
        assert_eq!(challenge.poll_secret, "SYNTHETIC_QRSIG");
        assert_eq!(challenge.mime_type, "image/png");
        assert_eq!(challenge.qr_bytes, b"\x89PNG");
        let urls = transport
            .captured
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        assert!(
            urls.iter().any(|url| url.contains("ssl.ptlogin2.qq.com")),
            "QQ QR must hit ptlogin2, got {urls:?}"
        );
    }
}
