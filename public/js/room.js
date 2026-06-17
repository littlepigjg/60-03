(async function () {
  const urlParams = new URLSearchParams(location.search);
  const debugMode = urlParams.get('debug');
  if (debugMode === 'host') {
    sessionStorage.setItem('mode', 'host');
    sessionStorage.setItem('userName', '调试主持人');
  } else if (debugMode === 'viewer') {
    sessionStorage.setItem('mode', 'viewer');
    sessionStorage.setItem('userName', '调试观众');
    sessionStorage.setItem('roomCode', '000000');
  }

  const mode = sessionStorage.getItem('mode');
  const savedName = sessionStorage.getItem('userName') || '';
  const savedRoomCode = sessionStorage.getItem('roomCode');

  if (!mode || (mode === 'viewer' && !savedRoomCode)) {
    location.href = '/';
    return;
  }

  const $ = Utils.$;
  const $$ = Utils.$$;

  const roleTag = $('#roleTag');
  const connStatus = $('#connStatus');
  const roomBadge = $('#roomBadge');
  const roomCodeText = $('#roomCodeText');
  const waitTitle = $('#waitTitle');
  const waitSubtitle = $('#waitSubtitle');
  const waitingScreen = $('#waitingScreen');
  const videoPlayer = $('#videoPlayer');
  const annotCanvas = $('#annotCanvas');
  const partList = $('#partList');
  const partCount = $('#partCount');
  const audioBtn = $('#audioBtn');
  const leaveBtn = $('#leaveBtn');

  const recordBtn = $('#recordBtn');
  const recordingControls = $('#recordingControls');
  const pauseRecBtn = $('#pauseRecBtn');
  const stopRecBtn = $('#stopRecBtn');
  const recordingTimer = $('#recordingTimer');
  const recordingIndicator = $('#recordingIndicator');
  const previewModal = $('#previewModal');
  const previewVideo = $('#previewVideo');
  const previewDuration = $('#previewDuration');
  const previewSize = $('#previewSize');
  const closePreviewBtn = $('#closePreviewBtn');
  const cancelDownloadBtn = $('#cancelDownloadBtn');
  const downloadBtn = $('#downloadBtn');
  const qualitySelect = $('#qualitySelect');

  let screenRecorder = null;
  let previewBlobUrl = null;
  let lastRecordingResult = null;

  roleTag.textContent = mode === 'host' ? '主持人' : '观看者';
  roleTag.className = 'role-tag ' + (mode === 'host' ? 'host' : 'viewer');

  if (mode !== 'host') {
    recordBtn.style.display = 'none';
  }

  const signaling = new SignalingClient();
  let webrtc = null;
  let annotation = null;
  let roomInfo = null;

  const userName = savedName || (mode === 'host' ? '主持人' : '观众') + Math.floor(Math.random() * 1000);

  try {
    await signaling.connect();
    signaling.setName(userName);
    connStatus.style.background = '#10b981';
    connStatus.textContent = '已连接';
  } catch (e) {
    connStatus.style.background = '#dc2626';
    connStatus.textContent = '连接失败';
    UI.toast('信令服务器连接失败');
    return;
  }

  annotation = new AnnotationManager(annotCanvas, signaling);
  setupAnnotationTools(annotation);

  webrtc = new WebRTCManager(signaling, signaling.clientId);
  webrtc.onStreamAdded = (peerId, stream) => {
    if (mode === 'viewer') {
      videoPlayer.srcObject = stream;
      waitingScreen.style.display = 'none';
      scheduleResize();
    }
  };
  webrtc.onStreamRemoved = (peerId) => {
    if (mode === 'viewer' && videoPlayer.srcObject) {
      const tracks = videoPlayer.srcObject.getVideoTracks();
      if (!tracks.length || tracks[0].readyState === 'ended') {
        videoPlayer.srcObject = null;
      }
    }
  };
  webrtc.emitStreamEnded = () => {
    if (mode === 'host') {
      if (screenRecorder && screenRecorder.isRecording) {
        screenRecorder.stop().then(() => {
          UI.toast('屏幕共享已停止，录制已保存');
          showPreview(lastRecordingResult);
        }).catch(() => {});
      }
      UI.toast('屏幕共享已停止，正在重新请求...');
      location.reload();
    }
  };

  roomBadge.addEventListener('click', () => {
    if (signaling.roomCode) {
      UI.copyText(signaling.roomCode);
    }
  });

  audioBtn.addEventListener('click', async () => {
    const enabled = await webrtc.toggleAudio();
    audioBtn.classList.toggle('active', enabled);
    audioBtn.querySelector('span').textContent = enabled ? '麦克风开' : '麦克风';
    UI.toast(enabled ? '麦克风已开启' : '麦克风已关闭');
  });

  leaveBtn.addEventListener('click', () => {
    if (screenRecorder && screenRecorder.isRecording) {
      if (!confirm('正在录制中，确定要离开吗？录制将自动停止并保存。')) {
        return;
      }
      screenRecorder.stop().then(() => {
        showPreview(lastRecordingResult);
        doLeave();
      }).catch(() => doLeave());
    } else {
      if (confirm('确定要离开房间吗？')) {
        doLeave();
      }
    }
  });

  function doLeave() {
    cleanup();
    location.href = '/';
  }

  if (mode === 'host') {
    recordBtn.addEventListener('click', startRecording);
  }
  pauseRecBtn.addEventListener('click', togglePauseRecording);
  stopRecBtn.addEventListener('click', stopRecording);

  closePreviewBtn.addEventListener('click', hidePreview);
  cancelDownloadBtn.addEventListener('click', hidePreview);
  previewModal.addEventListener('click', (e) => {
    if (e.target === previewModal) hidePreview();
  });
  downloadBtn.addEventListener('click', handleDownload);

  function startRecording() {
    if (!webrtc.localStream) {
      UI.toast('屏幕共享未就绪，无法录制');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      UI.toast('当前浏览器不支持录制功能');
      return;
    }

    try {
      const combinedStream = new MediaStream();
      webrtc.localStream.getVideoTracks().forEach(t => combinedStream.addTrack(t));
      if (webrtc.localAudioStream) {
        webrtc.localAudioStream.getAudioTracks().forEach(t => combinedStream.addTrack(t));
      }

      screenRecorder = new ScreenRecorder(combinedStream);
      screenRecorder.onStateChange = (state) => {
        if (state === 'error') {
          UI.toast('录制出错');
          resetRecordingUI();
        }
      };

      screenRecorder.start('webm', 'medium');
      lastRecordingResult = null;

      recordBtn.style.display = 'none';
      recordingControls.style.display = 'flex';
      recordBtn.classList.add('recording-active');
      recordingIndicator.classList.remove('paused');
      pauseRecBtn.querySelector('span').textContent = '暂停';
      UI.toast('开始录制');
    } catch (e) {
      console.error('startRecording failed:', e);
      UI.toast('启动录制失败: ' + (e.message || e));
    }
  }

  function togglePauseRecording() {
    if (!screenRecorder) return;
    if (screenRecorder.isPaused) {
      screenRecorder.resume();
      recordingIndicator.classList.remove('paused');
      pauseRecBtn.querySelector('span').textContent = '暂停';
      pauseRecBtn.querySelector('svg').innerHTML =
        '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
      UI.toast('继续录制');
    } else {
      screenRecorder.pause();
      recordingIndicator.classList.add('paused');
      pauseRecBtn.querySelector('span').textContent = '继续';
      pauseRecBtn.querySelector('svg').innerHTML =
        '<polygon points="5 3 19 12 5 21 5 3"/>';
      UI.toast('已暂停录制');
    }
  }

  async function stopRecording() {
    if (!screenRecorder) return;
    try {
      const result = await screenRecorder.stop();
      lastRecordingResult = result;
      resetRecordingUI();
      UI.toast('录制已完成');
      showPreview(result);
    } catch (e) {
      console.error('stopRecording failed:', e);
      UI.toast('停止录制失败: ' + (e.message || e));
      resetRecordingUI();
    }
  }

  function resetRecordingUI() {
    recordingControls.style.display = 'none';
    recordBtn.style.display = '';
    recordBtn.classList.remove('recording-active');
    recordingTimer.textContent = '00:00:00';
    recordingIndicator.classList.remove('paused');
    pauseRecBtn.querySelector('span').textContent = '暂停';
    pauseRecBtn.querySelector('svg').innerHTML =
      '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>';
  }

  function showPreview(result) {
    if (!result || !result.blob) return;

    if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
    previewBlobUrl = screenRecorder.getPreviewUrl();
    previewVideo.src = previewBlobUrl;
    previewDuration.textContent = ScreenRecorder.formatTime(result.duration);
    previewSize.textContent = ScreenRecorder.formatSize(result.blob.size);

    const mp4Radio = document.querySelector('input[name="format"][value="mp4"]');
    const webmRadio = document.querySelector('input[name="format"][value="webm"]');
    const hasAudio = webrtc.localAudioStream && webrtc.localAudioStream.getAudioTracks().length > 0;
    const supportsMp4 = ScreenRecorder.getSupportedMimeTypes().some(t => t.includes('mp4'));

    if (!supportsMp4) {
      mp4Radio.disabled = true;
      mp4Radio.checked = false;
      webmRadio.checked = true;
      const mp4Label = mp4Radio.closest('.radio-option');
      mp4Label.style.opacity = '0.5';
      mp4Label.title = '当前浏览器不支持MP4编码';
    }

    if (!hasAudio && supportsMp4) {
      mp4Radio.disabled = true;
      mp4Radio.checked = false;
      webmRadio.checked = true;
      const mp4Label = mp4Radio.closest('.radio-option');
      mp4Label.style.opacity = '0.5';
      mp4Label.title = '无音频轨时浏览器通常无法生成MP4';
    }

    previewModal.style.display = 'flex';
    setTimeout(() => { previewVideo.play().catch(() => {}); }, 100);
  }

  function hidePreview() {
    previewModal.style.display = 'none';
    previewVideo.pause();
    previewVideo.src = '';
    if (previewBlobUrl) {
      URL.revokeObjectURL(previewBlobUrl);
      previewBlobUrl = null;
    }
  }

  async function handleDownload() {
    if (!screenRecorder || !lastRecordingResult) return;

    const formatRadio = document.querySelector('input[name="format"]:checked');
    const format = formatRadio ? formatRadio.value : 'webm';
    const quality = qualitySelect.value;

    downloadBtn.disabled = true;
    const originalText = downloadBtn.textContent;
    downloadBtn.textContent = '处理中...';

    try {
      const result = await screenRecorder.convertBlob(format, quality);
      const ext = ScreenRecorder._getExtension(result.mimeType, format);
      const filename = ScreenRecorder.generateFileName(ext);
      ScreenRecorder.downloadBlob(result.blob, filename);

      if (result.note) {
        UI.toast(result.note);
      } else {
        UI.toast('已开始下载: ' + filename);
      }

      hidePreview();
    } catch (e) {
      console.error('handleDownload failed:', e);
      UI.toast('下载失败: ' + (e.message || e));
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = originalText;
    }
  }

  signaling.on('room-created', (msg) => {
    signaling.roomCode = msg.roomCode;
    roomCodeText.textContent = msg.roomCode;
    UI.toast('房间创建成功，房间码: ' + msg.roomCode);
  });

  signaling.on('room-joined', (msg) => {
    signaling.roomCode = msg.roomCode;
    roomCodeText.textContent = msg.roomCode;
    if (msg.annotations && msg.annotations.length) {
      annotation.loadInitial(msg.annotations);
    }
    UI.toast('已加入房间');
    setTimeout(() => {
      signaling.requestOffer(msg.hostId);
    }, 400);
  });

  signaling.on('room-info', (msg) => {
    roomInfo = msg.info;
    renderParticipants(msg.info);
  });

  signaling.on('peer-joined', (msg) => {
    UI.toast(`${msg.name} 加入了房间`);
    if (mode === 'host') {
      setTimeout(() => webrtc.initiateConnection(msg.peerId), 300);
    }
  });

  signaling.on('peer-left', (msg) => {
    webrtc.removePeer(msg.peerId);
  });

  signaling.on('room-destroyed', () => {
    UI.toast('主持人已结束共享，房间已关闭');
    setTimeout(() => {
      cleanup();
      location.href = '/';
    }, 1500);
  });

  signaling.on('error', (msg) => {
    UI.toast(msg.message || '错误');
    if (msg.message === '房间不存在') {
      setTimeout(() => { location.href = '/'; }, 1500);
    }
  });

  signaling.on('signal', async (msg) => {
    const data = msg.data;
    if (data.type === 'offer') {
      await webrtc.handleOffer(msg.from, data.sdp);
    } else if (data.type === 'answer') {
      await webrtc.handleAnswer(msg.from, data.sdp);
    }
  });

  signaling.on('ice-candidate', (msg) => {
    webrtc.handleIceCandidate(msg.from, msg.candidate);
  });

  signaling.on('request-offer', (msg) => {
    if (mode === 'host') {
      webrtc.initiateConnection(msg.from);
    }
  });

  signaling.on('annotation', (msg) => {
    annotation.receiveAnnotation(msg.annotation);
  });

  signaling.on('clear-annotations', () => {
    annotation.annotations = [];
    annotation.render();
    UI.toast('标注已被清空');
  });

  signaling.on('disconnected', () => {
    connStatus.style.background = '#dc2626';
    connStatus.textContent = '已断开';
    UI.toast('与服务器连接断开');
  });

  function renderParticipants(info) {
    if (!info) return;
    partCount.textContent = info.clients.length;
    UI.renderParticipantList(partList, info.clients, signaling.clientId);
  }

  function setupAnnotationTools(ann) {
    $$('.tool-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        $$('.tool-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        ann.setTool(btn.dataset.tool);
      });
    });
    $$('.color-swatch').forEach((sw) => {
      sw.addEventListener('click', () => {
        $$('.color-swatch').forEach((s) => s.classList.remove('active'));
        sw.classList.add('active');
        ann.setColor(sw.dataset.color);
      });
    });
    const strokeSlider = $('#strokeSlider');
    const strokeValue = $('#strokeValue');
    strokeSlider.addEventListener('input', () => {
      const v = parseInt(strokeSlider.value, 10);
      strokeValue.textContent = v;
      ann.setStroke(v);
    });
    $('#undoBtn').addEventListener('click', () => ann.undo());
    $('#clearBtn').addEventListener('click', () => {
      if (confirm('确定清空所有标注吗？')) ann.clearAll();
    });
  }

  const scheduleResize = Utils.debounce(() => {
    annotation._setupCanvas();
  }, 100);

  videoPlayer.addEventListener('loadedmetadata', scheduleResize);

  function cleanup() {
    try { signaling.leaveRoom(); } catch (e) { /* ignore */ }
    try { webrtc.destroy(); } catch (e) { /* ignore */ }
    try { screenRecorder && screenRecorder.destroy(); } catch (e) { /* ignore */ }
    if (previewBlobUrl) {
      URL.revokeObjectURL(previewBlobUrl);
    }
  }
  window.addEventListener('beforeunload', cleanup);

  if (mode === 'host') {
    waitTitle.textContent = '正在请求屏幕共享权限...';
    waitSubtitle.textContent = '请选择要共享的窗口或屏幕';
    try {
      const stream = await webrtc.acquireDisplay();
      videoPlayer.srcObject = stream;
      waitingScreen.style.display = 'none';
      signaling.createRoom();
      scheduleResize();
    } catch (e) {
      waitTitle.textContent = '屏幕共享未授权';
      waitSubtitle.textContent = '请刷新页面并授权屏幕捕获';
      connStatus.style.background = '#dc2626';
      connStatus.textContent = '未授权';
      UI.toast('需要授权屏幕捕获才能继续');
    }
  } else {
    waitTitle.textContent = '等待主持人开始共享...';
    waitSubtitle.textContent = '房间码: ' + savedRoomCode;
    signaling.joinRoom(savedRoomCode);
  }
})();
