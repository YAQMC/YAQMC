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
