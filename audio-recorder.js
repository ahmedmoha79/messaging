/**
 * Secure Logistics Audio Recorder Module - Professional Edition
 * Provides complete audio recording and playback functionality
 */

class AudioRecorder {
    constructor() {
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.recordingStartTime = null;
        this.recordingTimer = null;
        this.currentRecordingId = null;
        this.playbackInstances = new Map();
        this.supabaseClient = null;
        this.currentUserId = null;
        this.maxRecordingDuration = 300;
        this.audioContext = null;
        this.audioAnalyser = null;
        this.audioDataArray = null;
        this.visualizationInterval = null;
        this.isRecording = false;
        this.isPlaying = false;
        this.currentRecordingData = null;
    }

    initialize(supabaseClient, userId) {
        this.supabaseClient = supabaseClient;
        this.currentUserId = userId;
        
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.audioAnalyser = this.audioContext.createAnalyser();
            this.audioAnalyser.fftSize = 32;
        } catch (error) {
            console.error('Web Audio API not supported:', error);
        }
    }

    async checkMicrophonePermission() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
            return true;
        } catch (error) {
            console.error('Microphone permission denied:', error);
            return false;
        }
    }

    async startRecording() {
        if (this.isRecording) return;
        
        try {
            this.currentRecordingId = `audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            this.audioChunks = [];
            this.recordingStartTime = Date.now();
            this.isRecording = true;
            this.currentRecordingData = null;
            
            this.createRecordingUI();
            
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                } 
            });
            
            this.mediaRecorder = new MediaRecorder(stream);
            
            return new Promise((resolve) => {
                this.mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        this.audioChunks.push(event.data);
                    }
                };
                
                this.mediaRecorder.onstop = async () => {
                    this.isRecording = false;
                    const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
                    this.currentRecordingData = await this.processRecording(audioBlob);
                    resolve(this.currentRecordingData);
                    stream.getTracks().forEach(track => track.stop());
                };
                
                this.mediaRecorder.start(100);
                
                if (this.audioContext) {
                    const source = this.audioContext.createMediaStreamSource(stream);
                    source.connect(this.audioAnalyser);
                    this.audioDataArray = new Uint8Array(this.audioAnalyser.frequencyBinCount);
                    this.startVisualization();
                }
                
                this.recordingTimer = setInterval(() => {
                    const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
                    document.getElementById('recording-timer').textContent = this.formatTime(elapsed);
                    
                    if (elapsed >= this.maxRecordingDuration) {
                        this.stopRecording();
                    }
                }, 1000);
            });
            
        } catch (error) {
            console.error('Recording failed:', error);
            this.isRecording = false;
            this.clearRecordingUI();
            this.showError('Recording failed. Please check microphone permissions.');
            return null;
        }
    }

    stopRecording() {
        if (!this.isRecording || !this.mediaRecorder) return;
        clearInterval(this.recordingTimer);
        this.mediaRecorder.stop();
    }

    cancelRecording() {
        if (!this.isRecording) return;
        clearInterval(this.recordingTimer);
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
        }
        this.clearRecordingUI();
        this.currentRecordingData = null;
    }

    async processRecording(audioBlob) {
        try {
            this.showProcessingUI();
            const waveform = await this.generateWaveform(audioBlob);
            const duration = await this.getAudioDuration(audioBlob);
            
            const filePath = `audio_messages/${this.currentUserId}/${this.currentRecordingId}.webm`;
            const { data, error } = await this.supabaseClient.storage
                .from('audio_messages')
                .upload(filePath, audioBlob, {
                    contentType: 'audio/webm',
                    upsert: false,
                    cacheControl: '3600'
                });
            
            if (error) throw error;
            
            const { data: { publicUrl } } = this.supabaseClient.storage
                .from('audio_messages')
                .getPublicUrl(filePath);
            
            return {
                id: this.currentRecordingId,
                url: publicUrl,
                duration: duration,
                waveform: waveform,
                type: 'audio'
            };
            
        } catch (error) {
            console.error('Audio processing failed:', error);
            this.showError('Failed to process recording. Please try again.');
            return null;
        } finally {
            this.hideProcessingUI();
        }
    }

    renderAudioMessage(audioData, isSent) {
        const container = document.createElement('div');
        container.className = `audio-message-container ${isSent ? 'sent' : 'received'}`;
        container.dataset.messageId = audioData.id;
        container.dataset.waveform = JSON.stringify(audioData.waveform);

        // Create audio element
        const audioElement = document.createElement('audio');
        audioElement.src = audioData.url;
        audioElement.preload = 'metadata';
        container.appendChild(audioElement);

        // Create controls
        const controls = document.createElement('div');
        controls.className = 'audio-controls';

        // Play button
        const playButton = document.createElement('button');
        playButton.className = 'audio-play-button';
        playButton.innerHTML = '<i class="fas fa-play"></i>';
        controls.appendChild(playButton);

        // Progress bar
        const progressContainer = document.createElement('div');
        progressContainer.className = 'audio-progress-container';
        const progressBar = document.createElement('div');
        progressBar.className = 'audio-progress-bar';
        progressContainer.appendChild(progressBar);
        controls.appendChild(progressContainer);

        // Time display
        const timeDisplay = document.createElement('div');
        timeDisplay.className = 'audio-time';
        timeDisplay.textContent = this.formatTime(audioData.duration);
        controls.appendChild(timeDisplay);

        container.appendChild(controls);

        // Waveform visualization
        const visualizer = document.createElement('div');
        visualizer.className = 'audio-visualizer';
        audioData.waveform.forEach(value => {
            const bar = document.createElement('div');
            bar.className = 'audio-wave-bar';
            bar.style.height = `${value * 100}%`;
            visualizer.appendChild(bar);
        });
        container.appendChild(visualizer);

        // Event listeners
        playButton.addEventListener('click', () => {
            if (audioElement.paused) {
                audioElement.play();
            } else {
                audioElement.pause();
            }
        });

        audioElement.addEventListener('play', () => {
            playButton.innerHTML = '<i class="fas fa-pause"></i>';
            container.classList.add('playing');
        });

        audioElement.addEventListener('pause', () => {
            playButton.innerHTML = '<i class="fas fa-play"></i>';
            container.classList.remove('playing');
        });

        audioElement.addEventListener('timeupdate', () => {
            const progress = (audioElement.currentTime / audioElement.duration) * 100;
            progressBar.style.width = `${progress}%`;
            timeDisplay.textContent = this.formatTime(audioElement.currentTime);
        });

        progressContainer.addEventListener('click', (e) => {
            const rect = progressContainer.getBoundingClientRect();
            const pos = (e.clientX - rect.left) / rect.width;
            audioElement.currentTime = pos * audioElement.duration;
        });

        return container;
    }

    async playAudio(audioUrl, messageId, container) {
        if (this.isPlaying) {
            this.stopAllPlayback();
            return;
        }
        
        try {
            this.isPlaying = true;
            let audioElement = container.querySelector('audio');
            if (!audioElement) {
                audioElement = document.createElement('audio');
                container.appendChild(audioElement);
            }
            
            audioElement.src = audioUrl;
            
            let controls = container.querySelector('.audio-controls');
            if (!controls) {
                controls = this.createAudioControls(container, audioElement, messageId);
            }
            
            await audioElement.play();
            
        } catch (error) {
            console.error('Playback failed:', error);
            this.isPlaying = false;
        }
    }

    stopAllPlayback() {
        this.playbackInstances.forEach(instance => {
            instance.element.pause();
            instance.element.currentTime = 0;
        });
        this.isPlaying = false;
    }

    createRecordingUI() {
        let recordingContainer = document.getElementById('recording-container');
        if (!recordingContainer) {
            recordingContainer = document.createElement('div');
            recordingContainer.id = 'recording-container';
            recordingContainer.className = 'recording-container';
            recordingContainer.innerHTML = `
                <div class="recording-visualizer" id="recording-visualizer"></div>
                <div class="recording-controls">
                    <button class="recording-stop-button" id="recording-stop-button">
                        <i class="fas fa-stop"></i>
                    </button>
                    <span class="recording-timer" id="recording-timer">00:00</span>
                </div>
                <button class="recording-cancel-button" id="recording-cancel-button">
                    <i class="fas fa-times"></i>
                </button>
            `;
            document.body.appendChild(recordingContainer);
            
            document.getElementById('recording-stop-button').addEventListener('click', () => this.stopRecording());
            document.getElementById('recording-cancel-button').addEventListener('click', () => this.cancelRecording());
        }
        
        recordingContainer.style.display = 'flex';
    }

    showRecordingCompleteUI() {
        const recordingContainer = document.getElementById('recording-container');
        if (!recordingContainer) return;
        
        recordingContainer.innerHTML = `
            <div class="recording-complete-ui">
                <div class="recording-visualizer" id="recording-visualizer"></div>
                <span class="recording-timer" id="recording-timer">${this.formatTime(this.currentRecordingData.duration)}</span>
                <div class="recording-complete-controls">
                    <button class="recording-complete-button recording-send-button" id="recording-send-button">
                        <i class="fas fa-paper-plane"></i> Send
                    </button>
                    <button class="recording-complete-button recording-discard-button" id="recording-discard-button">
                        <i class="fas fa-trash"></i> Discard
                    </button>
                </div>
            </div>
        `;
        
        const visualizer = recordingContainer.querySelector('.recording-visualizer');
        if (visualizer && this.currentRecordingData.waveform) {
            this.currentRecordingData.waveform.forEach(value => {
                const bar = document.createElement('div');
                bar.className = 'visualizer-bar';
                bar.style.height = `${10 + (value * 50)}px`;
                visualizer.appendChild(bar);
            });
        }
        
        document.getElementById('recording-send-button').addEventListener('click', () => {
            this.clearRecordingUI();
        });
        
        document.getElementById('recording-discard-button').addEventListener('click', () => {
            this.cancelRecording();
        });
    }

    clearRecordingUI() {
        const recordingContainer = document.getElementById('recording-container');
        if (recordingContainer) {
            recordingContainer.style.display = 'none';
        }
        this.stopVisualization();
    }

    startVisualization() {
        if (!this.audioAnalyser || !this.audioDataArray) return;
        
        const visualizer = document.getElementById('recording-visualizer');
        if (!visualizer) return;
        
        visualizer.innerHTML = '';
        
        for (let i = 0; i < this.audioAnalyser.frequencyBinCount; i++) {
            const bar = document.createElement('div');
            bar.className = 'visualizer-bar';
            visualizer.appendChild(bar);
        }
        
        this.visualizationInterval = setInterval(() => {
            this.audioAnalyser.getByteFrequencyData(this.audioDataArray);
            const bars = visualizer.querySelectorAll('.visualizer-bar');
            
            for (let i = 0; i < bars.length; i++) {
                const value = this.audioDataArray[i] / 255;
                const height = 10 + (value * 50);
                bars[i].style.height = `${height}px`;
                bars[i].style.opacity = 0.5 + (value * 0.5);
            }
        }, 50);
    }

    stopVisualization() {
        if (this.visualizationInterval) {
            clearInterval(this.visualizationInterval);
            this.visualizationInterval = null;
        }
    }

    async generateWaveform(audioBlob) {
        return new Array(30).fill(0).map(() => Math.random() * 0.5 + 0.5);
    }

    async getAudioDuration(audioBlob) {
        return new Promise((resolve) => {
            const audio = new Audio();
            audio.src = URL.createObjectURL(audioBlob);
            audio.onloadedmetadata = () => {
                resolve(audio.duration);
                URL.revokeObjectURL(audio.src);
            };
            audio.onerror = () => resolve(0);
        });
    }

    formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }

    showProcessingUI() {
        const overlay = document.createElement('div');
        overlay.className = 'processing-overlay';
        overlay.innerHTML = `
            <div class="processing-spinner"></div>
            <div class="processing-text">Processing audio message...</div>
        `;
        document.body.appendChild(overlay);
    }

    hideProcessingUI() {
        const overlay = document.querySelector('.processing-overlay');
        if (overlay) {
            overlay.remove();
        }
    }

    showError(message) {
        const errorToast = document.createElement('div');
        errorToast.className = 'error-toast';
        errorToast.textContent = message;
        document.body.appendChild(errorToast);
        
        setTimeout(() => {
            errorToast.remove();
        }, 5000);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = AudioRecorder;
} else {
    window.AudioRecorder = AudioRecorder;
}