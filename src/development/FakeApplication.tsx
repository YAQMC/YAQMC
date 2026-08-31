import App from '../App';
import { MusicProviderRoot } from '../application/provider-root';
import { fakeMusicProvider } from '../providers/fake/fake-music-provider';

/** Development/QA-only offline shell. Release builds eliminate this module. */
export function FakeApplication() {
  return (
    <MusicProviderRoot provider={fakeMusicProvider}>
      <App />
    </MusicProviderRoot>
  );
}
