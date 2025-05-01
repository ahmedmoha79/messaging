/**
 * Enhanced Audio Recorder Module
 * Features:
 * - Reliable audio recording and playback
 * - Proper Supabase integration
 * - Modern UI with waveform visualization
 * - Robust error handling
 * - Automatic duration calculation
 * - Proper message persistence
 */

class EnhancedAudioRecorder {
    constructor() {
        // Core properties
        this.mediaRecorder = null;
        this.audioChunks = [];
        this.recordingStartTime = null;
        this.recordingTimer = null;
        this.currentRecordingId = null;
        this.playbackInstances = new Map();
        this.supabaseClient = null;
        this.currentUserId = null;
        
        // Audio context and analysis
        this.audioContext = null;
        this.audioAnalyser = null;
        this.audioDataArray = null;
        this.visualizationInterval = null;
        
        // State management
        this.isRecording = false;
        this.isPlaying = false;
        this.currentRecordingData = null;
        this.recordingContainer = null;
        this.recordingResolve = null;
        
        // Configuration
        this.maxRecordingDuration = 300; // 5 minutes max
        this.audioBucket = 'audio_messages';
        this.sampleRate = 16000; // 16kHz for voice
        this.channels = 1; // Mono for smaller files
        
        // UI elements
        this.recordingUI = null;
        this.processingUI = null;
        this.errorUI = null;
        
        // Initialize audio context
        this.initializeAudioContext();
    }

    // Initialize audio context and analyzer
    initializeAudioContext() {
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.audioAnalyser = this.audioContext.createAnalyser();
            this.audioAnalyser.fftSize = 256;
            this.audioAnalyser.smoothingTimeConstant = 0.8;
        } catch (error) {
            console.error('Web Audio API not supported:', error);
        }
    }

    // Initialize with Supabase client and user ID
    initialize(supabaseClient, userId) {
        this.supabaseClient = supabaseClient;
        this.currentUserId = userId;
        console.log('Audio recorder initialized with user:', userId);
    }

    // Check microphone permissions
    async checkMicrophonePermission() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
            return true;
        } catch (error) {
            console.error('Microphone permission denied:', error);
            this.showError('Microphone access is required for audio messages');
            return false;
        }
    }

    // Start recording
    async startRecording() {
        if (this.isRecording) {
            return Promise.reject("Already recording");
        }
        
        const hasPermission = await this.checkMicrophonePermission();
        if (!hasPermission) {
            return Promise.reject("Microphone permission denied");
        }

        try {
            // Generate unique ID for this recording
            this.currentRecordingId = `audio_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            this.audioChunks = [];
            this.recordingStartTime = Date.now();
            this.isRecording = true;
            this.currentRecordingData = null;
            
            // Create recording UI
            this.createRecordingUI();
            
            // Get audio stream with optimal settings
            const stream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: this.channels,
                    sampleRate: this.sampleRate
                } 
            });
            
            // Create media recorder with optimal settings
            this.mediaRecorder = new MediaRecorder(stream, {
                mimeType: 'audio/webm;codecs=opus',
                audioBitsPerSecond: this.sampleRate * 2 // 32kbps for voice
            });

            return new Promise((resolve, reject) => {
                this.recordingResolve = resolve;
                
                // Handle data available event
                this.mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0) {
                        this.audioChunks.push(event.data);
                    }
                };
                
                // Handle recording stop
                this.mediaRecorder.onstop = async () => {
                    this.isRecording = false;
                    clearInterval(this.recordingTimer);
                    this.stopVisualization();
                    
                    try {
                        const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
                        this.currentRecordingData = await this.processRecording(audioBlob);
                        
                        if (this.recordingResolve) {
                            this.recordingResolve(this.currentRecordingData);
                        }
                    } catch (error) {
                        console.error('Recording processing failed:', error);
                        this.showError('Failed to process recording. Please try again.');
                        if (this.recordingResolve) {
                            this.recordingResolve(null);
                        }
                    } finally {
                        stream.getTracks().forEach(track => track.stop());
                        this.clearRecordingUI();
                    }
                };
                
                // Handle recording errors
                this.mediaRecorder.onerror = (event) => {
                    console.error('Recording error:', event.error);
                    this.isRecording = false;
                    this.clearRecordingUI();
                    this.showError('Recording failed. Please try again.');
                    if (this.recordingResolve) {
                        this.recordingResolve(null);
                    }
                    stream.getTracks().forEach(track => track.stop());
                };
                
                // Start recording
                this.mediaRecorder.start(100); // Collect data every 100ms
                
                // Setup audio visualization
                if (this.audioContext) {
                    const source = this.audioContext.createMediaStreamSource(stream);
                    source.connect(this.audioAnalyser);
                    this.audioDataArray = new Uint8Array(this.audioAnalyser.frequencyBinCount);
                    this.startVisualization();
                }
                
                // Update timer
                this.recordingTimer = setInterval(() => {
                    const elapsed = Math.floor((Date.now() - this.recordingStartTime) / 1000);
                    if (this.recordingContainer) {
                        const timerElement = this.recordingContainer.querySelector('#recording-timer');
                        if (timerElement) {
                            timerElement.textContent = this.formatTime(elapsed);
                        }
                    }
                    
                    // Auto-stop if exceeded max duration
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
            return Promise.reject(error);
        }
    }

    // Stop recording
    stopRecording() {
        if (!this.isRecording || !this.mediaRecorder) return;
        this.mediaRecorder.stop();
    }

    // Cancel recording
    cancelRecording() {
        if (!this.isRecording) return;
        
        clearInterval(this.recordingTimer);
        this.stopVisualization();
        
        if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
            this.mediaRecorder.stop();
            // Clear audio chunks to prevent processing
            this.audioChunks = [];
        }
        
        this.clearRecordingUI();
        this.currentRecordingData = null;
        this.isRecording = false;
        
        if (this.recordingResolve) {
            this.recordingResolve(null);
        }
    }

    // Process recording
    async processRecording(audioBlob) {
        // If no audio chunks, recording was cancelled
        if (this.audioChunks.length === 0) {
            return null;
        }

        this.showProcessingUI();
        
        try {
            // Calculate actual recording duration
            const actualDuration = (Date.now() - this.recordingStartTime) / 1000;
            
            // Generate waveform and validate duration in parallel
            const [waveform, duration] = await Promise.all([
                this.generateWaveform(audioBlob),
                this.getAudioDuration(audioBlob, actualDuration)
            ]);
            
            // Validate audio
            if (duration <= 0.1) {
                throw new Error("Audio too short or invalid");
            }
            
            // Upload to storage with proper error handling
            const filePath = `${this.audioBucket}/${this.currentUserId}/${this.currentRecordingId}.webm`;
            const uploadResponse = await this.supabaseClient.storage
                .from(this.audioBucket)
                .upload(filePath, audioBlob, {
                    contentType: 'audio/webm',
                    upsert: false,
                    cacheControl: '3600'
                });
            
            if (uploadResponse.error) {
                throw uploadResponse.error;
            }
            
            // Get public URL
            const { data: { publicUrl } } = this.supabaseClient.storage
                .from(this.audioBucket)
                .getPublicUrl(filePath, {
                    download: false
                });
            
            if (!publicUrl) {
                throw new Error("Failed to get public URL for audio");
            }

            // Return complete audio data
            return {
                id: this.currentRecordingId,
                url: publicUrl,
                duration: Math.round(duration),
                waveform: waveform,
                type: 'audio',
                mimeType: 'audio/webm',
                size: audioBlob.size,
                created_at: new Date().toISOString()
            };
            
        } catch (error) {
            console.error('Audio processing failed:', error);
            this.showError('Failed to process recording. Please try again.');
            return null;
        } finally {
            this.hideProcessingUI();
        }
    }

    // Get audio duration with fallback
    async getAudioDuration(audioBlob, fallbackDuration) {
        return new Promise((resolve) => {
            const audio = new Audio();
            audio.src = URL.createObjectURL(audioBlob);
            
            const onLoaded = () => {
                const duration = audio.duration;
                console.log('Audio duration:', duration);
                
                // Use fallback if duration is invalid
                const finalDuration = isFinite(duration) && duration > 0 ? duration : fallbackDuration;
                console.log('Final duration:', finalDuration);
                
                resolve(finalDuration);
                URL.revokeObjectURL(audio.src);
                audio.removeEventListener('loadedmetadata', onLoaded);
            };
            
            audio.addEventListener('loadedmetadata', onLoaded, { once: true });
            audio.addEventListener('error', () => resolve(fallbackDuration));
        });
    }

    // Generate waveform data
    async generateWaveform(audioBlob) {
        return new Promise((resolve) => {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const fileReader = new FileReader();
            
            fileReader.onload = async (e) => {
                try {
                    const arrayBuffer = e.target.result;
                    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
                    
                    // Downsample to 30 points for the waveform
                    const channelData = audioBuffer.getChannelData(0);
                    const blockSize = Math.floor(channelData.length / 30);
                    const waveform = [];
                    
                    for (let i = 0; i < 30; i++) {
                        const blockStart = i * blockSize;
                        const blockEnd = Math.min(blockStart + blockSize, channelData.length);
                        let sum = 0;
                        
                        for (let j = blockStart; j < blockEnd; j++) {
                            sum += Math.abs(channelData[j]);
                        }
                        
                        const avg = sum / (blockEnd - blockStart);
                        waveform.push(avg);
                    }
                    
                    // Normalize waveform to 0-1 range
                    const max = Math.max(...waveform);
                    if (max > 0) {
                        for (let i = 0; i < waveform.length; i++) {
                            waveform[i] = waveform[i] / max;
                        }
                    }
                    
                    resolve(waveform);
                } catch (error) {
                    console.error('Waveform generation error:', error);
                    resolve(new Array(30).fill(0.5));
                } finally {
                    audioContext.close();
                }
            };
            
            fileReader.onerror = () => {
                console.error('FileReader error');
                resolve(new Array(30).fill(0.5));
            };
            
            fileReader.readAsArrayBuffer(audioBlob);
        });
    }

    // Render audio message
    renderAudioMessage(audioData, isSent) {
        if (!audioData || !audioData.url) {
            console.error('Invalid audio data:', audioData);
            const fallback = document.createElement('div');
            fallback.className = 'message-content';
            fallback.textContent = '[Audio message not available]';
            return fallback;
        }

        const container = document.createElement('div');
        container.className = `message ${isSent ? 'sent' : 'received'}`;
        container.dataset.messageId = audioData.id;
        container.dataset.audioId = audioData.id;

        const messageContent = document.createElement('div');
        messageContent.className = 'message-content';

        const audioContainer = document.createElement('div');
        audioContainer.className = 'audio-message-container';

        // Create audio element
        const audioElement = document.createElement('audio');
        audioElement.src = audioData.url;
        audioElement.preload = 'metadata';
        audioElement.controls = false;
        audioElement.setAttribute('data-audio-id', audioData.id);
        audioContainer.appendChild(audioElement);

        // Controls container - make this more compact
        const controls = document.createElement('div');
        controls.className = 'audio-controls';

        // Play/pause button - smaller and matching sent/received style
        const playButton = document.createElement('button');
        playButton.className = 'audio-play-button';
        playButton.innerHTML = '<i class="fas fa-play" style="font-size: 12px;"></i>';
        playButton.setAttribute('aria-label', 'Play audio message');
        controls.appendChild(playButton);

        // Progress container - thinner progress bar
        const progressContainer = document.createElement('div');
        progressContainer.className = 'audio-progress-container';

        // Progress bar
        const progressBar = document.createElement('div');
        progressBar.className = 'audio-progress-bar';
        progressContainer.appendChild(progressBar);
        controls.appendChild(progressContainer);

        // Time display - smaller font
        const timeDisplay = document.createElement('div');
        timeDisplay.className = 'audio-time';
        timeDisplay.textContent = this.formatTime(audioData.duration || 0);
        controls.appendChild(timeDisplay);

        audioContainer.appendChild(controls);

        // Waveform visualization - make it more compact
        if (audioData.waveform && audioData.waveform.length > 0) {
            const visualizer = document.createElement('div');
            visualizer.className = 'audio-visualizer';
            
            // Use fewer bars for a more compact look
            const step = Math.ceil(audioData.waveform.length / 12); // Show only 12 bars
            for (let i = 0; i < 12; i++) {
                const idx = Math.min(i * step, audioData.waveform.length - 1);
                const value = audioData.waveform[idx];
                const bar = document.createElement('div');
                bar.className = 'audio-wave-bar';
                bar.style.height = `${Math.max(2, value * 20)}px`;
                bar.style.opacity = 0.5 + (value * 0.5);
                visualizer.appendChild(bar);
            }
            
            audioContainer.appendChild(visualizer);
        }

        messageContent.appendChild(audioContainer);
        container.appendChild(messageContent);

        // Time stamp
        const timeStamp = document.createElement('span');
        timeStamp.className = 'message-time';
        timeStamp.textContent = new Date().toLocaleTimeString([], { 
            hour: '2-digit', 
            minute: '2-digit',
            timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
        });
        messageContent.appendChild(timeStamp);

        // Add status container for sent messages
        const statusContainer = document.createElement('div');
        statusContainer.className = `message-status ${isSent ? 'sent' : ''}`;

        if (isSent) {
            // Add status icons only for sent messages
            const statusIcon = document.createElement('i');
            statusIcon.className = 'status-icon delivered fas fa-check';
            statusContainer.appendChild(statusIcon);
            
            // You'll update this dynamically when status changes
            statusContainer.dataset.messageId = audioData.id;
            statusContainer.dataset.status = 'delivered'; // Default status
        }

        messageContent.appendChild(statusContainer);

        // Event listeners
        playButton.addEventListener('click', () => this.toggleAudioPlayback(audioElement, playButton));
        
        audioElement.addEventListener('timeupdate', () => {
            const progress = (audioElement.currentTime / (audioElement.duration || 1)) * 100;
            progressBar.style.width = `${progress}%`;
            timeDisplay.textContent = this.formatTime(audioElement.currentTime);
        });

        audioElement.addEventListener('ended', () => {
            playButton.innerHTML = '<i class="fas fa-play" style="font-size: 12px;"></i>';
            container.classList.remove('playing');
        });

        audioElement.addEventListener('error', (e) => {
            console.error('Audio loading error:', e);
            console.error('Audio URL:', audioData.url);
            this.showError('Failed to load audio: ' + (e.target.error?.message || 'Unknown error'));
            playButton.disabled = true;
        });

        progressContainer.addEventListener('click', (e) => {
            if (!audioElement.duration) return;
            const rect = progressContainer.getBoundingClientRect();
            const pos = (e.clientX - rect.left) / rect.width;
            audioElement.currentTime = pos * audioElement.duration;
        });

        return container;
    }

    // Toggle audio playback
    toggleAudioPlayback(audioElement, playButton) {
        if (audioElement.paused) {
            this.stopAllPlayback();
            audioElement.play()
                .then(() => {
                    playButton.innerHTML = '<i class="fas fa-pause"></i>';
                    audioElement.parentElement.parentElement.parentElement.classList.add('playing');
                })
                .catch(error => {
                    console.error('Playback failed:', error);
                    this.showError('Could not play audio');
                });
        } else {
            audioElement.pause();
            playButton.innerHTML = '<i class="fas fa-play"></i>';
            audioElement.parentElement.parentElement.parentElement.classList.remove('playing');
        }
    }

    // Stop all playback
    stopAllPlayback() {
        document.querySelectorAll('audio').forEach(audio => {
            if (!audio.paused) {
                audio.pause();
                audio.currentTime = 0;
                const playButton = audio.parentElement.querySelector('.audio-play-button');
                if (playButton) {
                    playButton.innerHTML = '<i class="fas fa-play"></i>';
                }
                audio.parentElement.parentElement.parentElement.classList.remove('playing');
            }
        });
    }

    // Create recording UI
    createRecordingUI() {
        this.clearRecordingUI();
        
        this.recordingContainer = document.createElement('div');
        this.recordingContainer.id = 'recording-container';
        this.recordingContainer.className = 'recording-container';
        this.recordingContainer.innerHTML = `
            <div class="recording-header">
                <i class="fas fa-microphone"></i>
                <span>Recording...</span>
            </div>
            <div class="recording-visualizer" id="recording-visualizer"></div>
            <div class="recording-controls">
                <button class="recording-stop-button" id="recording-stop-button" title="Send">
                    <i class="fas fa-check"></i>
                </button>
                <span class="recording-timer" id="recording-timer">00:00</span>
                <button class="recording-cancel-button" id="recording-cancel-button" title="Cancel">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `;
        
        document.body.appendChild(this.recordingContainer);
        
        // Event listeners
        this.recordingContainer.querySelector('#recording-stop-button')
            .addEventListener('click', () => this.stopRecording());
            
        this.recordingContainer.querySelector('#recording-cancel-button')
            .addEventListener('click', () => this.cancelRecording());
    }

    // Start visualization
    startVisualization() {
        if (!this.audioAnalyser || !this.audioDataArray) return;
        
        const visualizer = this.recordingContainer?.querySelector('#recording-visualizer');
        if (!visualizer) return;
        
        visualizer.innerHTML = '';
        
        // Create 16 bars for visualization
        for (let i = 0; i < 16; i++) {
            const bar = document.createElement('div');
            bar.className = 'visualizer-bar';
            visualizer.appendChild(bar);
        }
        
        this.visualizationInterval = setInterval(() => {
            this.audioAnalyser.getByteFrequencyData(this.audioDataArray);
            const bars = visualizer.querySelectorAll('.visualizer-bar');
            
            // We have more data points than bars, so we average them
            const step = Math.floor(this.audioDataArray.length / bars.length);
            
            for (let i = 0; i < bars.length; i++) {
                let sum = 0;
                for (let j = 0; j < step; j++) {
                    sum += this.audioDataArray[(i * step) + j] || 0;
                }
                const avg = sum / step;
                const value = avg / 255;
                
                bars[i].style.height = `${10 + (value * 50)}px`;
                bars[i].style.opacity = 0.5 + (value * 0.5);
                bars[i].style.backgroundColor = `hsl(${200 + (value * 100)}, 100%, 50%)`;
            }
        }, 50);
    }

    // Stop visualization
    stopVisualization() {
        if (this.visualizationInterval) {
            clearInterval(this.visualizationInterval);
            this.visualizationInterval = null;
        }
    }

    // Clear recording UI
    clearRecordingUI() {
        if (this.recordingContainer) {
            this.recordingContainer.remove();
            this.recordingContainer = null;
        }
        this.stopVisualization();
    }

    // Format time
    formatTime(seconds) {
        if (isNaN(seconds)) return '0:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
    }

    // Show processing UI
    showProcessingUI() {
        this.clearRecordingUI();
        
        const overlay = document.createElement('div');
        overlay.className = 'processing-overlay';
        overlay.innerHTML = `
            <div class="processing-spinner"></div>
            <div class="processing-text">Processing audio message...</div>
        `;
        document.body.appendChild(overlay);
    }

    // Hide processing UI
    hideProcessingUI() {
        const overlay = document.querySelector('.processing-overlay');
        if (overlay) {
            overlay.remove();
        }
    }

    // Show error
    showError(message) {
        const errorToast = document.createElement('div');
        errorToast.className = 'error-toast';
        errorToast.innerHTML = `
            <i class="fas fa-exclamation-circle"></i>
            <span>${message}</span>
        `;
        document.body.appendChild(errorToast);
        
        setTimeout(() => {
            errorToast.classList.add('fade-out');
            setTimeout(() => {
                errorToast.remove();
            }, 300);
        }, 5000);
    }
}

// Export for both browser and Node.js environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = EnhancedAudioRecorder;
} else {
    window.EnhancedAudioRecorder = EnhancedAudioRecorder;
}