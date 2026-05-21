(function() {
  'use strict';

  // ----- Tab switching -----
  const tabs = document.querySelectorAll('.tab');
  const panels = {
    make: document.getElementById('panel-make'),
    detect: document.getElementById('panel-detect')
  };
  let activeTab = 'make';

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.setAttribute('aria-selected', t === tab ? 'true' : 'false'));
      Object.keys(panels).forEach(k => {
        panels[k].classList.toggle('active', k === target);
      });
      const wasDetect = activeTab === 'detect';
      activeTab = target;
      if (wasDetect && target !== 'detect') {
        stopDetection();
      }
    });
  });

  // ============================================================
  // MARKER GENERATION (6x6 ArUco dictionary, OpenCV DICT_6X6_1000)
  // ============================================================
  const DICT_NAME = 'ARUCO_6X6_1000';
  const dict = AR.DICTIONARIES[DICT_NAME]; // { nBits: 36, codeList: [...] }
  const N_BITS = dict.nBits;               // 36
  const SIDE = Math.sqrt(N_BITS);          // 6
  const GRID = SIDE + 2;                   // 8 (with 1-cell black border)
  const MAX_ID = dict.codeList.length - 1; // 249

  function getMarkerBits(id) {
    if (id < 0 || id >= dict.codeList.length) return null;
    const code = dict.codeList[id];
    const bin = code.toString(2).padStart(N_BITS, '0');
    const grid = [];
    for (let r = 0; r < SIDE; r++) {
      const row = [];
      for (let c = 0; c < SIDE; c++) {
        row.push(parseInt(bin[r * SIDE + c], 10)); // 1 = white, 0 = black
      }
      grid.push(row);
    }
    return grid;
  }

  function renderMarker(id) {
    const bits = getMarkerBits(id);
    const svg = document.getElementById('markerSvg');
    const idTag = document.getElementById('idTag');
    if (!bits) {
      svg.innerHTML = '';
      idTag.textContent = 'ID ?';
      return;
    }
    idTag.textContent = 'ID ' + id;

    svg.setAttribute('viewBox', `0 0 ${GRID} ${GRID}`);

    let html = '';
    html += `<rect x="0" y="0" width="${GRID}" height="${GRID}" fill="white"/>`;
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        let isBlack = false;
        if (r === 0 || r === GRID - 1 || c === 0 || c === GRID - 1) {
          isBlack = true;
        } else {
          const bit = bits[r - 1][c - 1];
          isBlack = (bit === 0);
        }
        if (isBlack) {
          html += `<rect x="${c}" y="${r}" width="1" height="1" fill="#14110f"/>`;
        }
      }
    }
    for (let i = 1; i < GRID; i++) {
      html += `<line x1="${i}" y1="0" x2="${i}" y2="${GRID}" stroke="rgba(120,120,120,0.25)" stroke-width="0.02"/>`;
      html += `<line x1="0" y1="${i}" x2="${GRID}" y2="${i}" stroke="rgba(120,120,120,0.25)" stroke-width="0.02"/>`;
    }
    svg.innerHTML = html;
  }

  function clampId(v) {
    let n = parseInt(v, 10);
    if (isNaN(n)) n = 0;
    n = Math.max(0, Math.min(MAX_ID, n));
    return n;
  }

  const idInput = document.getElementById('idInput');
  const btnMake = document.getElementById('btnMake');
  idInput.max = String(MAX_ID);

  function handleMake() {
    const n = clampId(idInput.value);
    idInput.value = n;
    renderMarker(n);
  }

  btnMake.addEventListener('click', handleMake);
  idInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleMake();
  });
  idInput.addEventListener('input', () => {
    const v = parseInt(idInput.value, 10);
    if (!isNaN(v) && v >= 0 && v <= MAX_ID) renderMarker(v);
  });

  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      idInput.value = chip.dataset.id;
      handleMake();
    });
  });

  renderMarker(42);

  // ============================================================
  // MARKER DETECTION (webcam)
  // ============================================================
  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay');
  const overlayCtx = overlay.getContext('2d');
  const videoOverlayEl = document.getElementById('videoOverlay');
  const btnCam = document.getElementById('btnCam');
  const resultIdEl = document.getElementById('resultId');
  const resultStatusEl = document.getElementById('resultStatus');
  const statFpsEl = document.getElementById('statFps');
  const statCountEl = document.getElementById('statCount');

  let stream = null;
  let detector = null;
  let processCanvas = null;
  let processCtx = null;
  let rafId = null;
  let lastFrameTime = 0;
  let fpsAvg = 0;
  let lastDetectedId = null;
  let lastDetectedAt = 0;

  function ensureDetector() {
    if (!detector) {
      detector = new AR.Detector({ dictionaryName: DICT_NAME });
    }
  }

  async function startDetection() {
    if (stream) return;
    ensureDetector();
    btnCam.disabled = true;
    btnCam.textContent = '카메라 시작 중...';
    resultStatusEl.textContent = '카메라 준비 중...';
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: { ideal: 'user' } },
          audio: false
        });
      } catch (e1) {
        if (e1.name === 'OverconstrainedError' || e1.name === 'NotFoundError') {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        } else {
          throw e1;
        }
      }
      video.srcObject = stream;
      await new Promise((resolve) => {
        if (video.readyState >= 1) resolve();
        else video.onloadedmetadata = () => resolve();
      });
      await video.play();
      videoOverlayEl.classList.add('hidden');

      processCanvas = document.createElement('canvas');
      processCanvas.width = video.videoWidth || 640;
      processCanvas.height = video.videoHeight || 480;
      processCtx = processCanvas.getContext('2d', { willReadFrequently: true });

      overlay.width = processCanvas.width;
      overlay.height = processCanvas.height;

      btnCam.textContent = '⏹ 카메라 끄기';
      btnCam.disabled = false;
      resultStatusEl.textContent = '카드를 카메라에 비춰주세요';
      lastFrameTime = performance.now();
      tick();
    } catch (err) {
      console.error('Camera error:', err);
      btnCam.disabled = false;
      btnCam.textContent = '📷 카메라 시작';
      let title, hint;
      switch (err.name) {
        case 'NotAllowedError':
        case 'PermissionDeniedError':
          title = '카메라 권한이<br>거부되었어요';
          hint = '주소창의 자물쇠 아이콘 → 카메라 → 허용으로<br>변경 후 새로고침 해주세요';
          break;
        case 'NotFoundError':
        case 'DevicesNotFoundError':
          title = '카메라를<br>찾을 수 없어요';
          hint = '노트북 카메라가 켜져 있는지 확인해주세요';
          break;
        case 'NotReadableError':
        case 'TrackStartError':
          title = '카메라가 다른 앱에서<br>사용 중이에요';
          hint = 'Zoom, Teams, 카메라 앱 등을<br>모두 종료한 뒤 다시 시도해주세요';
          break;
        default:
          title = '카메라를 켤 수 없어요';
          hint = '에러: ' + (err.name || err.message || '알 수 없음');
      }
      resultStatusEl.textContent = title.replace(/<br>/g, ' ');
      videoOverlayEl.classList.remove('hidden');
      videoOverlayEl.innerHTML = title + '<br><br><span style="font-size:14px; opacity:0.7; font-family: var(--body); font-weight: 400;">' + hint + '</span>';
    }
  }

  function stopDetection() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
      stream = null;
    }
    video.srcObject = null;
    videoOverlayEl.classList.remove('hidden');
    videoOverlayEl.innerHTML = '카메라를 켜고<br>그린 보안카드를<br>화면에 비춰보세요';
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    btnCam.textContent = '📷 카메라 시작';
    resultStatusEl.textContent = '대기 중';
    resultIdEl.textContent = '--';
    resultIdEl.classList.remove('detected');
    statFpsEl.textContent = '0';
    statCountEl.textContent = '0';
  }

  function tick() {
    if (!stream) return;
    const now = performance.now();
    const dt = now - lastFrameTime;
    lastFrameTime = now;
    if (dt > 0) {
      const fps = 1000 / dt;
      fpsAvg = fpsAvg * 0.8 + fps * 0.2;
      statFpsEl.textContent = fpsAvg.toFixed(0);
    }

    try {
      processCtx.drawImage(video, 0, 0, processCanvas.width, processCanvas.height);
      const imgData = processCtx.getImageData(0, 0, processCanvas.width, processCanvas.height);
      const markers = detector.detect(imgData);

      overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
      statCountEl.textContent = markers.length;

      if (markers && markers.length > 0) {
        let best = markers[0], bestArea = 0;
        for (const m of markers) {
          const a = polyArea(m.corners);
          if (a > bestArea) { bestArea = a; best = m; }
        }

        for (const m of markers) {
          drawMarkerOutline(m, m === best);
        }

        const id = best.id;
        if (id !== lastDetectedId) {
          lastDetectedId = id;
          resultIdEl.textContent = String(id);
          resultIdEl.classList.add('detected');
          resultStatusEl.textContent = '인식 성공!';
          lastDetectedAt = now;
          setTimeout(() => resultIdEl.classList.remove('detected'), 400);
        }
        lastDetectedAt = now;
      } else {
        if (lastDetectedId !== null && now - lastDetectedAt > 1500) {
          lastDetectedId = null;
          resultIdEl.textContent = '--';
          resultStatusEl.textContent = '카드를 카메라에 비춰주세요';
        }
      }
    } catch (e) {
      console.error('Detection error:', e);
    }

    rafId = requestAnimationFrame(tick);
  }

  function polyArea(corners) {
    let a = 0;
    for (let i = 0; i < corners.length; i++) {
      const j = (i + 1) % corners.length;
      a += corners[i].x * corners[j].y - corners[j].x * corners[i].y;
    }
    return Math.abs(a / 2);
  }

  function drawMarkerOutline(marker, isPrimary) {
    const corners = marker.corners;
    overlayCtx.beginPath();
    overlayCtx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < corners.length; i++) overlayCtx.lineTo(corners[i].x, corners[i].y);
    overlayCtx.closePath();
    overlayCtx.lineWidth = isPrimary ? 6 : 3;
    overlayCtx.strokeStyle = isPrimary ? '#4dffaa' : '#ffd84d';
    overlayCtx.stroke();

    if (isPrimary) {
      const cx = corners.reduce((s, p) => s + p.x, 0) / corners.length;
      const cy = corners.reduce((s, p) => s + p.y, 0) / corners.length;
      overlayCtx.fillStyle = '#14110f';
      overlayCtx.fillRect(cx - 50, cy - 22, 100, 44);
      overlayCtx.strokeStyle = '#4dffaa';
      overlayCtx.lineWidth = 3;
      overlayCtx.strokeRect(cx - 50, cy - 22, 100, 44);
      overlayCtx.fillStyle = '#4dffaa';
      overlayCtx.font = 'bold 28px monospace';
      overlayCtx.textAlign = 'center';
      overlayCtx.textBaseline = 'middle';
      overlayCtx.fillText('ID ' + marker.id, cx, cy);
    }
  }

  btnCam.addEventListener('click', () => {
    if (stream) stopDetection();
    else startDetection();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && stream) stopDetection();
  });

})();
