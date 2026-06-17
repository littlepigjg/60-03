class ScreenRecorder {
  constructor(stream) {
    this.stream = stream;
    this.mediaRecorder = null;
    this.chunks = [];
    this.isRecording = false;
    this.isPaused = false;
    this.startTime = 0;
    this.elapsedBeforePause = 0;
    this.timerInterval = null;
    this.onTick = null;
    this.onStateChange = null;
    this.finalBlob = null;
    this.finalMimeType = '';
    this.finalDuration = 0;
  }

  static getSupportedMimeTypes() {
    const types = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
      'video/mp4;codecs=h264,aac',
      'video/mp4'
    ];
    return types.filter(t => MediaRecorder.isTypeSupported(t));
  }

  static pickMimeType(format = 'webm') {
    const supported = ScreenRecorder.getSupportedMimeTypes();
    if (format === 'mp4') {
      const mp4 = supported.find(t => t.includes('mp4'));
      if (mp4) return mp4;
    }
    const webm = supported.find(t => t.includes('webm'));
    return webm || supported[0] || '';
  }

  static getQualityBitrate(quality = 'medium') {
    switch (quality) {
      case 'high': return 8000000;
      case 'low': return 1500000;
      case 'medium':
      default: return 4000000;
    }
  }

  start(format = 'webm', quality = 'medium') {
    if (!this.stream) {
      throw new Error('没有可用的视频流');
    }
    if (this.isRecording) {
      throw new Error('录制已在进行中');
    }

    const mimeType = ScreenRecorder.pickMimeType(format);
    const bitrate = ScreenRecorder.getQualityBitrate(quality);
    const options = { videoBitsPerSecond: bitrate };
    if (mimeType) options.mimeType = mimeType;

    try {
      this.mediaRecorder = new MediaRecorder(this.stream, options);
    } catch (e) {
      this.mediaRecorder = new MediaRecorder(this.stream);
    }

    this.chunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.chunks.push(e.data);
      }
    };

    this.mediaRecorder.onerror = (e) => {
      console.error('录制错误:', e);
      this._stopTimer();
      this.isRecording = false;
      this.isPaused = false;
      if (this.onStateChange) this.onStateChange('error');
    };

    this.mediaRecorder.start(1000);

    this.isRecording = true;
    this.isPaused = false;
    this.startTime = Date.now();
    this.elapsedBeforePause = 0;
    this._startTimer();

    if (this.onStateChange) this.onStateChange('started');
  }

  pause() {
    if (!this.isRecording || this.isPaused || !this.mediaRecorder) return;
    if (this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.pause();
      this.elapsedBeforePause += Date.now() - this.startTime;
      this._stopTimer();
      this.isPaused = true;
      if (this.onStateChange) this.onStateChange('paused');
    }
  }

  resume() {
    if (!this.isRecording || !this.isPaused || !this.mediaRecorder) return;
    if (this.mediaRecorder.state === 'paused') {
      this.mediaRecorder.resume();
      this.startTime = Date.now();
      this._startTimer();
      this.isPaused = false;
      if (this.onStateChange) this.onStateChange('resumed');
    }
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.isRecording || !this.mediaRecorder) {
        reject(new Error('未在录制'));
        return;
      }

      this.mediaRecorder.onstop = () => {
        this._stopTimer();
        this.finalDuration = this._getElapsed();
        const mimeType = this.mediaRecorder.mimeType || 'video/webm';
        this.finalMimeType = mimeType;
        this.finalBlob = new Blob(this.chunks, { type: mimeType });
        this.isRecording = false;
        this.isPaused = false;
        if (this.onStateChange) this.onStateChange('stopped');
        resolve({
          blob: this.finalBlob,
          mimeType: this.finalMimeType,
          duration: this.finalDuration
        });
      };

      try {
        this.mediaRecorder.stop();
      } catch (e) {
        reject(e);
      }
    });
  }

  convertBlob(targetFormat, quality) {
    if (!this.finalBlob) return Promise.reject('没有录制数据');
    const currentMime = this.finalBlob.type || '';
    const targetMime = targetFormat === 'mp4' ? 'video/mp4' : 'video/webm';
    const isCurrentWebm = currentMime.includes('webm');
    const isTargetWebm = targetMime.includes('webm');

    if ((isCurrentWebm && isTargetWebm) || (!isCurrentWebm && !isTargetWebm)) {
      return Promise.resolve({
        blob: this.finalBlob,
        mimeType: currentMime || targetMime,
        extension: this._getExtension(currentMime || targetMime),
        converted: false
      });
    }

    return this._reencode(targetFormat, quality).then(result => {
      result.converted = true;
      return result;
    }).catch(() => {
      return {
        blob: this.finalBlob,
        mimeType: currentMime || targetMime,
        extension: ScreenRecorder._getExtension(currentMime || targetMime, targetFormat),
        converted: false,
        note: '浏览器不支持该格式转换，将使用原始格式下载'
      };
    });
  }

  _reencode(targetFormat, quality) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.src = URL.createObjectURL(this.finalBlob);
      video.muted = true;
      video.playsInline = true;

      video.onloadedmetadata = () => {
        const w = video.videoWidth;
        const h = video.videoHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');

        try {
          const stream = canvas.captureStream(30);
          const mimeType = ScreenRecorder.pickMimeType(targetFormat);
          const bitrate = ScreenRecorder.getQualityBitrate(quality);
          const opts = { videoBitsPerSecond: bitrate };
          if (mimeType) opts.mimeType = mimeType;

          let rec;
          try {
            rec = new MediaRecorder(stream, opts);
          } catch (e) {
            rec = new MediaRecorder(stream);
          }

          const chunks = [];
          rec.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
          };
          rec.onstop = () => {
            video.pause();
            URL.revokeObjectURL(video.src);
            const outMime = rec.mimeType || (targetFormat === 'mp4' ? 'video/mp4' : 'video/webm');
            resolve({
              blob: new Blob(chunks, { type: outMime }),
              mimeType: outMime,
              extension: ScreenRecorder._getExtension(outMime, targetFormat)
            });
          };

          rec.start(100);
          video.currentTime = 0;
          video.play();

          const drawFrame = () => {
            if (video.ended || video.paused) {
              ctx.drawImage(video, 0, 0, w, h);
              setTimeout(() => rec.stop(), 100);
              return;
            }
            ctx.drawImage(video, 0, 0, w, h);
            requestAnimationFrame(drawFrame);
          };
          drawFrame();

        } catch (e) {
          URL.revokeObjectURL(video.src);
          reject(e);
        }
      };

      video.onerror = () => {
        URL.revokeObjectURL(video.src);
        reject(new Error('无法加载录制视频'));
      };
    });
  }

  static _getExtension(mimeType, preferredFormat) {
    if (preferredFormat === 'mp4') return 'mp4';
    if (preferredFormat === 'webm') return 'webm';
    if (mimeType.includes('mp4')) return 'mp4';
    return 'webm';
  }

  _getExtension(mimeType, preferredFormat) {
    return ScreenRecorder._getExtension(mimeType, preferredFormat);
  }

  static formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
    const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }

  static formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  static generateFileName(extension) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    return `screen_recording_${stamp}.${extension}`;
  }

  static downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  getPreviewUrl() {
    if (!this.finalBlob) return null;
    return URL.createObjectURL(this.finalBlob);
  }

  _getElapsed() {
    let elapsed = this.elapsedBeforePause;
    if (!this.isPaused && this.startTime) {
      elapsed += Date.now() - this.startTime;
    }
    return elapsed;
  }

  _startTimer() {
    const timerEl = document.getElementById('recordingTimer');
    if (timerEl) timerEl.textContent = '00:00:00';
    this.timerInterval = setInterval(() => {
      const elapsed = this._getElapsed();
      if (this.onTick) {
        this.onTick(elapsed, ScreenRecorder.formatTime(elapsed));
      }
      if (timerEl) {
        timerEl.textContent = ScreenRecorder.formatTime(elapsed);
      }
    }, 250);
  }

  _stopTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  destroy() {
    this._stopTimer();
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch (e) {}
    }
    this.chunks = [];
    this.finalBlob = null;
    this.isRecording = false;
    this.isPaused = false;
  }
}
