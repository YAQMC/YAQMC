import { pinyinForLines } from './lyrics-pinyin-convert';

// Loading pinyin-pro's dictionary and converting a song costs hundreds of milliseconds, so it
// never runs on the WebView main thread.
self.onmessage = (event: MessageEvent<string[]>) => {
  self.postMessage(pinyinForLines(event.data));
};
