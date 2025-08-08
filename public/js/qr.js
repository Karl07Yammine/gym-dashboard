let html5QrCode;
let cameras = [];
let currentCamIndex = 0;
let scanning = false;
let stopping = false;
let autoRestartTimer = null;

const regionId = "qrRegion";
const resultEl = () => document.getElementById("scanResult");
const stopBtn = () => document.getElementById("stopBtn");
const switchBtn = () => document.getElementById("switchBtn");
const photoBox = () => document.getElementById("memberPhoto");
const photoImg = () => document.getElementById("memberPhotoImg");

function setResult(msg, badge) {
  let text = msg;
  if (badge) {
    const pill = `<span class="pill ${badge === 'ok' ? 'ok' : 'bad'}">${badge}</span>`;
    text += ' ' + pill;
  }
  resultEl().innerHTML = text;
}

function setRunningUI(isRunning) {
  scanning = isRunning;
  if (stopBtn()) stopBtn().textContent = isRunning ? "Stop" : "Start";
}

function hidePhoto() {
  photoBox().style.display = 'none';
  photoImg().src = '';
}

function showPhoto(url) {
  if (!url) return hidePhoto();
  photoImg().src = url;
  photoBox().style.display = 'block';
}

function onScanFailure(_) { /* noisy; ignore */ }

async function onScanSuccess(decodedText) {
  if (!/^\d{6}$/.test(decodedText)) return;
  if (stopping) return;
  stopping = true;

  setResult(`Scanned: ${decodedText}`);
  hidePhoto();

  try { await stop(); } catch(_) {}

  fetch('/api/scan/check-in', {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ payload: decodedText })
  })
    .then(r => r.json())
    .then(data => {
      if (!data.ok) {
        setResult(data.message || 'Error', 'bad');
        return;
      }

      // status handling
      if (data.status === 'expired') {
        setResult(data.message || 'Membership expired.', 'bad');
        hidePhoto();
      } else if (data.status === 'no_membership') {
        setResult(data.message || 'No membership found.', 'bad');
        hidePhoto();
      } else if (data.status === 'active') {
        const badge = data.action === 'checkout' ? 'ok' : 'ok';
        const msg = data.action === 'checkout'
          ? data.message
          : data.message;
        setResult(msg, badge);
        if (data.photoUrl) showPhoto(data.photoUrl);
      } else {
        setResult(data.message || 'Processed.');
      }
    })
    .catch(err => {
      setResult('Server error: ' + err, 'bad');
    })
    .finally(() => {
      // Auto-restart
      const RESTART_MS = 3000;
      autoRestartTimer && clearTimeout(autoRestartTimer);
      autoRestartTimer = setTimeout(async () => {
        stopping = false;
        try {
          if (cameras.length) {
            await start(cameras[currentCamIndex].id);
          } else {
            await start({ facingMode: { ideal: "environment" } });
          }
          setResult('Ready for next scan.');
          hidePhoto();
        } catch (e) {
          setResult(`Restart error: ${e?.message || e}`, 'bad');
        }
      }, RESTART_MS);
    });
}

async function start(camConfig) {
  if (scanning) return;
  const width = Math.min(window.innerWidth - 32, 420);
  const box = Math.max(180, Math.min(300, width - 40));
  const config = { fps: 10, qrbox: { width: box, height: box } };

  if (!html5QrCode) html5QrCode = new Html5Qrcode(regionId, { verbose: false });
  await html5QrCode.start(camConfig, config, onScanSuccess, onScanFailure);
  setRunningUI(true);
}

async function stop() {
  if (!html5QrCode || !scanning) {
    setRunningUI(false);
    return;
  }
  await html5QrCode.stop();
  await html5QrCode.clear();
  setRunningUI(false);
}

async function init() {
  try {
    cameras = await Html5Qrcode.getCameras();
    if (!cameras.length) {
      setResult("No camera found.", 'bad');
      return;
    }
    const back = cameras.findIndex(d => /back|rear|environment/i.test(d.label));
    currentCamIndex = back >= 0 ? back : 0;
    await start(cameras[currentCamIndex].id);
    setResult('Point the camera at a QR code…');
  } catch (e) {
    setResult("Camera error: " + (e?.message || e), 'bad');
  }

  if (switchBtn()) {
    switchBtn().addEventListener("click", async () => {
      if (!cameras.length) return;
      autoRestartTimer && clearTimeout(autoRestartTimer);
      try {
        await stop();
        currentCamIndex = (currentCamIndex + 1) % cameras.length;
        await start(cameras[currentCamIndex].id);
        setResult('Scanner running.');
        hidePhoto();
      } catch (e) {
        setResult(`Camera error: ${e?.message || e}`, 'bad');
      }
    });
  }

  if (stopBtn()) {
    stopBtn().addEventListener("click", async () => {
      autoRestartTimer && clearTimeout(autoRestartTimer);
      if (scanning) {
        await stop();
        setResult("Scanner stopped.");
        hidePhoto();
      } else {
        try {
          if (cameras.length) await start(cameras[currentCamIndex].id);
          else await start({ facingMode: { ideal: "environment" } });
          setResult("Scanner running.");
        } catch (e) {
          setResult(`Camera error: ${e?.message || e}`, 'bad');
        }
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", init);
