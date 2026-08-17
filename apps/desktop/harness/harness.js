const status = document.getElementById('status');

function setTitle(title) {
  document.title = title;
}

async function run() {
  try {
    const yaqmc = window.yaqmc;
    if (!yaqmc || typeof yaqmc.invoke !== 'function') {
      throw new Error('window.yaqmc.invoke is missing');
    }
    if (!location.href.startsWith('app:')) {
      throw new Error(`expected app:// harness, got ${location.href}`);
    }
    location.href = 'https://example.invalid/blocked';
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    if (!location.href.startsWith('app:')) {
      throw new Error(`external navigation escaped containment: ${location.href}`);
    }
    const snapshot = await yaqmc.invoke('player_snapshot');
    if (snapshot === null || typeof snapshot !== 'object') {
      throw new Error('player_snapshot returned a non-object');
    }
    if (status) {
      status.textContent = 'ok';
    }
    setTitle('yaqmc-smoke-ok');
  } catch (error) {
    if (status) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
    console.error(error);
    setTitle('yaqmc-smoke-fail');
  }
}

void run();
