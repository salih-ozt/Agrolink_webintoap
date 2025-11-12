// ===== CONFIGURATION =====
const CONFIG = {
    API_BASE_URL: 'https://api.agrolink.com/v1',
    SOCKET_URL: 'wss://ws.agrolink.com',
    UPLOAD_URL: 'https://upload.agrolink.com',
    MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB
    MAX_IMAGE_WIDTH: 2080,
    MAX_IMAGE_HEIGHT: 1080,
    VIDEO_QUALITIES: {
        low: { width: 640, height: 360 },
        medium: { width: 1280, height: 720 },
        high: { width: 1920, height: 1080 },
        ultra: { width: 3840, height: 2160 }
    },
    SUPPORTED_FORMATS: {
        image: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
        video: ['mp4', 'mov', 'avi', 'mkv', 'webm'],
        audio: ['mp3', 'wav', 'ogg', 'm4a']
    },
    PRIVACY_OPTIONS: {
        PUBLIC: 'public',
        FOLLOWERS: 'followers',
        PRIVATE: 'private'
    }
};

// ===== GLOBAL STATE =====
class AppState {
    constructor() {
        this.currentUser = null;
        this.authToken = null;
        this.socket = null;
        this.isOnline = navigator.onLine;
        this.theme = localStorage.getItem('agrolink_theme') || 'light';
        this.language = localStorage.getItem('agrolink_language') || 'tr';
        this.notifications = [];
        this.messages = [];
        this.feed = [];
        this.stories = [];
        this.explore = [];
        this.liveStreams = [];
        this.uploadQueue = new Map();
        this.audioContext = null;
        this.mediaRecorder = null;
        this.currentStream = null;
        
        this.initialize();
    }

    initialize() {
        this.loadFromStorage();
        this.setupEventListeners();
        this.applyTheme();
    }

    loadFromStorage() {
        const savedUser = localStorage.getItem('agrolink_user');
        const savedToken = localStorage.getItem('agrolink_token');
        
        if (savedUser && savedToken) {
            this.currentUser = JSON.parse(savedUser);
            this.authToken = savedToken;
        }
    }

    saveToStorage() {
        if (this.currentUser) {
            localStorage.setItem('agrolink_user', JSON.stringify(this.currentUser));
        }
        if (this.authToken) {
            localStorage.setItem('agrolink_token', this.authToken);
        }
    }

    setupEventListeners() {
        window.addEventListener('online', () => this.handleOnline());
        window.addEventListener('offline', () => this.handleOffline());
        window.addEventListener('beforeunload', () => this.cleanup());
        
        // Visibility change for background tasks
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.pauseMedia();
            } else {
                this.resumeMedia();
            }
        });
    }

    handleOnline() {
        this.isOnline = true;
        this.showToast('İnternet bağlantısı yeniden sağlandı', 'success');
        this.syncData();
    }

    handleOffline() {
        this.isOnline = false;
        this.showToast('İnternet bağlantısı kesildi', 'warning');
    }

    applyTheme() {
        document.documentElement.setAttribute('data-theme', this.theme);
    }

    toggleTheme() {
        this.theme = this.theme === 'light' ? 'dark' : 'light';
        localStorage.setItem('agrolink_theme', this.theme);
        this.applyTheme();
    }

    cleanup() {
        if (this.socket) {
            this.socket.close();
        }
        if (this.audioContext) {
            this.audioContext.close();
        }
        if (this.currentStream) {
            this.currentStream.getTracks().forEach(track => track.stop());
        }
    }

    // Session management
    async validateSession() {
        if (!this.authToken) return false;

        try {
            const response = await this.apiCall('/auth/validate', {
                method: 'GET'
            });
            return response.valid;
        } catch (error) {
            return false;
        }
    }

    async refreshToken() {
        try {
            const response = await this.apiCall('/auth/refresh', {
                method: 'POST'
            });
            this.authToken = response.token;
            this.saveToStorage();
            return true;
        } catch (error) {
            this.logout();
            return false;
        }
    }

    logout() {
        this.currentUser = null;
        this.authToken = null;
        localStorage.removeItem('agrolink_user');
        localStorage.removeItem('agrolink_token');
        this.cleanup();
        window.location.reload();
    }
}

// ===== API SERVICE =====
class ApiService {
    constructor(baseURL) {
        this.baseURL = baseURL;
        this.pendingRequests = new Map();
        this.requestQueue = [];
        this.isProcessingQueue = false;
    }

    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        const requestId = this.generateRequestId();
        
        const config = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                ...options.headers
            },
            ...options
        };

        // Add auth token if available
        const token = appState.authToken;
        if (token) {
            config.headers['Authorization'] = `Bearer ${token}`;
        }

        try {
            const response = await fetch(url, config);
            
            if (response.status === 401) {
                // Token expired, try to refresh
                const refreshed = await appState.refreshToken();
                if (refreshed) {
                    // Retry request with new token
                    return this.request(endpoint, options);
                } else {
                    throw new Error('Authentication failed');
                }
            }

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            return data;
        } catch (error) {
            console.error('API Request failed:', error);
            throw error;
        }
    }

    generateRequestId() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }

    // Specific API methods
    async authLogin(credentials) {
        return this.request('/auth/login', {
            method: 'POST',
            body: JSON.stringify(credentials)
        });
    }

    async authRegister(userData) {
        return this.request('/auth/register', {
            method: 'POST',
            body: JSON.stringify(userData)
        });
    }

    async sendVerificationCode(phone) {
        return this.request('/auth/verify/send', {
            method: 'POST',
            body: JSON.stringify({ phone })
        });
    }

    async verifyCode(phone, code) {
        return this.request('/auth/verify/check', {
            method: 'POST',
            body: JSON.stringify({ phone, code })
        });
    }

    async createPost(postData) {
        const formData = new FormData();
        
        // Append post data
        formData.append('caption', postData.caption || '');
        formData.append('audience', postData.audience || 'public');
        formData.append('disableComments', postData.disableComments || false);
        formData.append('disableLikes', postData.disableLikes || false);
        formData.append('location', JSON.stringify(postData.location || {}));
        
        // Append media files
        if (postData.mediaFiles) {
            postData.mediaFiles.forEach((file, index) => {
                formData.append(`media_${index}`, file);
            });
        }

        return this.request('/posts', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${appState.authToken}`
            },
            body: formData
        });
    }

    async getFeed(page = 1, limit = 10) {
        return this.request(`/feed?page=${page}&limit=${limit}`);
    }

    async getUserProfile(userId) {
        return this.request(`/users/${userId}`);
    }

    async followUser(userId) {
        return this.request(`/users/${userId}/follow`, {
            method: 'POST'
        });
    }

    async unfollowUser(userId) {
        return this.request(`/users/${userId}/unfollow`, {
            method: 'POST'
        });
    }

    async likePost(postId) {
        return this.request(`/posts/${postId}/like`, {
            method: 'POST'
        });
    }

    async unlikePost(postId) {
        return this.request(`/posts/${postId}/unlike`, {
            method: 'POST'
        });
    }

    async addComment(postId, comment) {
        return this.request(`/posts/${postId}/comments`, {
            method: 'POST',
            body: JSON.stringify({ content: comment })
        });
    }

    async deleteComment(postId, commentId) {
        return this.request(`/posts/${postId}/comments/${commentId}`, {
            method: 'DELETE'
        });
    }

    async startLiveStream(streamData) {
        return this.request('/live/start', {
            method: 'POST',
            body: JSON.stringify(streamData)
        });
    }

    async stopLiveStream(streamId) {
        return this.request(`/live/${streamId}/stop`, {
            method: 'POST'
        });
    }

    async getLiveStreams() {
        return this.request('/live/streams');
    }
}

// ===== LIVE STREAM MANAGER =====
class LiveStreamManager {
    constructor() {
        this.currentStream = null;
        this.peerConnections = new Map();
        this.mediaStream = null;
        this.isLive = false;
        this.viewers = 0;
        this.streamId = null;
    }

    async startStream(streamData) {
        try {
            // Get user media
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                    frameRate: { ideal: 30 }
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                }
            });

            // Initialize WebRTC
            await this.initializeWebRTC();

            // Start stream with backend
            const response = await apiService.startLiveStream(streamData);
            this.streamId = response.streamId;
            this.isLive = true;

            // Start sending stream data
            this.startStreaming();

            return response;
        } catch (error) {
            console.error('Failed to start live stream:', error);
            throw error;
        }
    }

    async initializeWebRTC() {
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };

        this.peerConnection = new RTCPeerConnection(configuration);

        // Add local stream tracks
        this.mediaStream.getTracks().forEach(track => {
            this.peerConnection.addTrack(track, this.mediaStream);
        });

        // Handle ICE candidates
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendIceCandidate(event.candidate);
            }
        };

        // Handle incoming streams
        this.peerConnection.ontrack = (event) => {
            this.handleRemoteStream(event.streams[0]);
        };
    }

    async startStreaming() {
        // Create offer
        const offer = await this.peerConnection.createOffer();
        await this.peerConnection.setLocalDescription(offer);

        // Send offer to signaling server
        await this.sendOffer(offer);
    }

    async stopStream() {
        if (!this.isLive) return;

        try {
            await apiService.stopLiveStream(this.streamId);
            
            // Stop media tracks
            this.mediaStream.getTracks().forEach(track => track.stop());
            
            // Close peer connections
            this.peerConnection.close();
            this.peerConnections.forEach(pc => pc.close());
            this.peerConnections.clear();

            this.isLive = false;
            this.streamId = null;
            this.viewers = 0;
        } catch (error) {
            console.error('Failed to stop live stream:', error);
            throw error;
        }
    }

    async joinStream(streamId) {
        try {
            const response = await apiService.joinLiveStream(streamId);
            await this.initializeViewerConnection(response);
            return response;
        } catch (error) {
            console.error('Failed to join live stream:', error);
            throw error;
        }
    }

    handleRemoteStream(stream) {
        // Display remote stream in UI
        const videoElement = document.createElement('video');
        videoElement.srcObject = stream;
        videoElement.autoplay = true;
        videoElement.controls = true;
        videoElement.playsInline = true;

        const container = document.getElementById('liveStreamContainer');
        if (container) {
            container.appendChild(videoElement);
        }
    }

    sendIceCandidate(candidate) {
        // Send ICE candidate to signaling server
        if (appState.socket) {
            appState.socket.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: candidate,
                streamId: this.streamId
            }));
        }
    }

    async sendOffer(offer) {
        if (appState.socket) {
            appState.socket.send(JSON.stringify({
                type: 'offer',
                offer: offer,
                streamId: this.streamId
            }));
        }
    }
}

// ===== POST MANAGER =====
class PostManager {
    constructor() {
        this.currentPost = null;
        this.uploadProgress = new Map();
        this.mediaProcessor = new MediaProcessor();
    }

    async createPost(postData) {
        try {
            // Process media files
            const processedMedia = await this.processMediaFiles(postData.mediaFiles);
            
            // Update post data with processed media
            const finalPostData = {
                ...postData,
                mediaFiles: processedMedia
            };

            // Show upload progress
            this.showUploadProgress();

            // Create post via API
            const response = await apiService.createPost(finalPostData);
            
            // Hide progress
            this.hideUploadProgress();

            return response;
        } catch (error) {
            console.error('Failed to create post:', error);
            this.hideUploadProgress();
            throw error;
        }
    }

    async processMediaFiles(files) {
        const processedFiles = [];

        for (const file of files) {
            try {
                const processedFile = await this.mediaProcessor.processFile(file);
                processedFiles.push(processedFile);
                
                // Update progress
                this.uploadProgress.set(file.name, {
                    progress: 100,
                    status: 'processed'
                });
                this.updateProgressUI();
            } catch (error) {
                console.error('Failed to process media file:', error);
                throw error;
            }
        }

        return processedFiles;
    }

    showUploadProgress() {
        const progressElement = document.getElementById('uploadProgress');
        if (progressElement) {
            progressElement.style.display = 'flex';
        }
    }

    hideUploadProgress() {
        const progressElement = document.getElementById('uploadProgress');
        if (progressElement) {
            progressElement.style.display = 'none';
        }
        this.uploadProgress.clear();
    }

    updateProgressUI() {
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        
        if (!progressFill || !progressText) return;

        let totalProgress = 0;
        let totalFiles = this.uploadProgress.size;

        this.uploadProgress.forEach((fileProgress) => {
            totalProgress += fileProgress.progress;
        });

        const averageProgress = totalFiles > 0 ? totalProgress / totalFiles : 0;
        const progressPercent = Math.round(averageProgress);

        progressFill.style.width = `${progressPercent}%`;
        progressText.textContent = `%${progressPercent}`;

        // Update status text based on progress
        if (progressPercent < 25) {
            progressText.textContent += ' - Sunucuya bağlanılıyor...';
        } else if (progressPercent < 50) {
            progressText.textContent += ' - Medya yükleniyor...';
        } else if (progressPercent < 75) {
            progressText.textContent += ' - İşleniyor...';
        } else if (progressPercent < 100) {
            progressText.textContent += ' - Sonlandırılıyor...';
        } else {
            progressText.textContent += ' - Tamamlandı!';
        }
    }

    async deletePost(postId) {
        try {
            await apiService.deletePost(postId);
            this.showToast('Gönderi silindi', 'success');
        } catch (error) {
            console.error('Failed to delete post:', error);
            throw error;
        }
    }

    async editPost(postId, updates) {
        try {
            const response = await apiService.editPost(postId, updates);
            this.showToast('Gönderi güncellendi', 'success');
            return response;
        } catch (error) {
            console.error('Failed to edit post:', error);
            throw error;
        }
    }

    async likePost(postId) {
        try {
            await apiService.likePost(postId);
        } catch (error) {
            console.error('Failed to like post:', error);
            throw error;
        }
    }

    async unlikePost(postId) {
        try {
            await apiService.unlikePost(postId);
        } catch (error) {
            console.error('Failed to unlike post:', error);
            throw error;
        }
    }
}

// ===== MEDIA PROCESSOR =====
class MediaProcessor {
    constructor() {
        this.supportedFormats = CONFIG.SUPPORTED_FORMATS;
        this.maxFileSize = CONFIG.MAX_FILE_SIZE;
    }

    async processFile(file) {
        this.validateFile(file);
        
        const fileType = this.getFileType(file);
        let processedFile = file;

        switch (fileType) {
            case 'image':
                processedFile = await this.processImage(file);
                break;
            case 'video':
                processedFile = await this.processVideo(file);
                break;
            case 'audio':
                processedFile = await this.processAudio(file);
                break;
            default:
                throw new Error('Desteklenmeyen dosya formatı');
        }

        return processedFile;
    }

    validateFile(file) {
        // Check file size
        if (file.size > this.maxFileSize) {
            throw new Error(`Dosya boyutu çok büyük. Maksimum: ${this.formatFileSize(this.maxFileSize)}`);
        }

        // Check file type
        const fileExtension = this.getFileExtension(file.name);
        const fileType = this.getFileType(file);
        
        if (!fileType || !this.supportedFormats[fileType].includes(fileExtension.toLowerCase())) {
            throw new Error('Desteklenmeyen dosya formatı');
        }
    }

    getFileType(file) {
        const type = file.type.split('/')[0];
        return this.supportedFormats[type] ? type : null;
    }

    getFileExtension(filename) {
        return filename.split('.').pop().toLowerCase();
    }

    async processImage(file) {
        return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement('canvas');
                    const ctx = canvas.getContext('2d');

                    // Calculate new dimensions while maintaining aspect ratio
                    let { width, height } = this.calculateDimensions(
                        img.width, 
                        img.height, 
                        CONFIG.MAX_IMAGE_WIDTH, 
                        CONFIG.MAX_IMAGE_HEIGHT
                    );

                    canvas.width = width;
                    canvas.height = height;

                    // Draw image with high quality
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'high';
                    ctx.drawImage(img, 0, 0, width, height);

                    // Convert to blob with quality settings
                    canvas.toBlob((blob) => {
                        const processedFile = new File([blob], file.name, {
                            type: 'image/jpeg',
                            lastModified: Date.now()
                        });
                        resolve(processedFile);
                    }, 'image/jpeg', 0.9);
                };
                img.src = e.target.result;
            };
            reader.readAsDataURL(file);
        });
    }

    async processVideo(file) {
        // For videos, we'll create a compressed version
        // This is a simplified version - in production you'd use FFmpeg or similar
        return new Promise((resolve) => {
            // Create a video element to get video properties
            const video = document.createElement('video');
            video.src = URL.createObjectURL(file);
            
            video.onloadedmetadata = () => {
                // For now, we'll return the original file
                // In production, you'd implement actual video compression
                resolve(file);
                URL.revokeObjectURL(video.src);
            };
        });
    }

    async processAudio(file) {
        // Audio processing would go here
        return file;
    }

    calculateDimensions(originalWidth, originalHeight, maxWidth, maxHeight) {
        let width = originalWidth;
        let height = originalHeight;

        if (width > maxWidth) {
            height = (height * maxWidth) / width;
            width = maxWidth;
        }

        if (height > maxHeight) {
            width = (width * maxHeight) / height;
            height = maxHeight;
        }

        return { width: Math.round(width), height: Math.round(height) };
    }

    formatFileSize(bytes) {
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        if (bytes === 0) return '0 Bytes';
        const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
        return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
    }
}

// ===== LOCATION SERVICE =====
class LocationService {
    constructor() {
        this.currentLocation = null;
        this.watchId = null;
    }

    async getCurrentLocation() {
        return new Promise((resolve, reject) => {
            if (!navigator.geolocation) {
                reject(new Error('Geolocation is not supported'));
                return;
            }

            const options = {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 60000
            };

            navigator.geolocation.getCurrentPosition(
                async (position) => {
                    try {
                        const location = await this.reverseGeocode(
                            position.coords.latitude,
                            position.coords.longitude
                        );
                        this.currentLocation = location;
                        resolve(location);
                    } catch (error) {
                        reject(error);
                    }
                },
                (error) => {
                    reject(this.getLocationError(error));
                },
                options
            );
        });
    }

    async reverseGeocode(lat, lng) {
        try {
            // Using OpenStreetMap Nominatim for reverse geocoding
            const response = await fetch(
                `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`
            );
            
            if (!response.ok) {
                throw new Error('Geocoding failed');
            }

            const data = await response.json();
            
            return {
                latitude: lat,
                longitude: lng,
                address: data.display_name,
                city: data.address.city || data.address.town || data.address.village,
                country: data.address.country,
                country_code: data.address.country_code
            };
        } catch (error) {
            console.error('Reverse geocoding failed:', error);
            return {
                latitude: lat,
                longitude: lng,
                address: 'Konum bilgisi alınamadı'
            };
        }
    }

    startWatching() {
        if (!navigator.geolocation) return;

        const options = {
            enableHighAccuracy: true,
            timeout: 5000,
            maximumAge: 30000
        };

        this.watchId = navigator.geolocation.watchPosition(
            async (position) => {
                try {
                    const location = await this.reverseGeocode(
                        position.coords.latitude,
                        position.coords.longitude
                    );
                    this.currentLocation = location;
                } catch (error) {
                    console.error('Location watch error:', error);
                }
            },
            (error) => {
                console.error('Location watch failed:', error);
            },
            options
        );
    }

    stopWatching() {
        if (this.watchId) {
            navigator.geolocation.clearWatch(this.watchId);
            this.watchId = null;
        }
    }

    getLocationError(error) {
        switch (error.code) {
            case error.PERMISSION_DENIED:
                return new Error('Konum erişimi reddedildi');
            case error.POSITION_UNAVAILABLE:
                return new Error('Konum bilgisi alınamıyor');
            case error.TIMEOUT:
                return new Error('Konum alma zaman aşımına uğradı');
            default:
                return new Error('Bilinmeyen konum hatası');
        }
    }

    calculateDistance(lat1, lon1, lat2, lon2) {
        const R = 6371; // Earth's radius in kilometers
        const dLat = this.deg2rad(lat2 - lat1);
        const dLon = this.deg2rad(lon2 - lon1);
        
        const a = 
            Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(this.deg2rad(lat1)) * Math.cos(this.deg2rad(lat2)) * 
            Math.sin(dLon/2) * Math.sin(dLon/2);
        
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
        const distance = R * c; // Distance in km
        
        return distance;
    }

    deg2rad(deg) {
        return deg * (Math.PI/180);
    }
}

// ===== NOTIFICATION MANAGER =====
class NotificationManager {
    constructor() {
        this.notifications = [];
        this.unreadCount = 0;
        this.pushPermission = null;
    }

    async initialize() {
        await this.requestPushPermission();
        this.setupServiceWorker();
        this.loadNotifications();
    }

    async requestPushPermission() {
        if (!('Notification' in window)) {
            console.log('This browser does not support notifications');
            return;
        }

        this.pushPermission = Notification.permission;
        
        if (this.pushPermission === 'default') {
            this.pushPermission = await Notification.requestPermission();
        }
    }

    setupServiceWorker() {
        if ('serviceWorker' in navigator && 'PushManager' in window) {
            navigator.serviceWorker.register('/sw.js')
                .then((registration) => {
                    console.log('Service Worker registered');
                })
                .catch((error) => {
                    console.log('Service Worker registration failed:', error);
                });
        }
    }

    async loadNotifications() {
        try {
            const response = await apiService.getNotifications();
            this.notifications = response.notifications;
            this.unreadCount = response.unreadCount;
            this.updateBadge();
        } catch (error) {
            console.error('Failed to load notifications:', error);
        }
    }

    async markAsRead(notificationId) {
        try {
            await apiService.markNotificationRead(notificationId);
            this.unreadCount = Math.max(0, this.unreadCount - 1);
            this.updateBadge();
        } catch (error) {
            console.error('Failed to mark notification as read:', error);
        }
    }

    async markAllAsRead() {
        try {
            await apiService.markAllNotificationsRead();
            this.unreadCount = 0;
            this.updateBadge();
        } catch (error) {
            console.error('Failed to mark all notifications as read:', error);
        }
    }

    showLocalNotification(title, options) {
        if (this.pushPermission === 'granted') {
            new Notification(title, options);
        }
    }

    updateBadge() {
        const badge = document.getElementById('notificationBadge');
        if (badge) {
            if (this.unreadCount > 0) {
                badge.textContent = this.unreadCount > 99 ? '99+' : this.unreadCount;
                badge.style.display = 'flex';
            } else {
                badge.style.display = 'none';
            }
        }
    }

    // Real-time notification handling
    handleRealTimeNotification(notification) {
        this.notifications.unshift(notification);
        this.unreadCount++;
        this.updateBadge();
        
        // Show desktop notification
        this.showLocalNotification(notification.title, {
            body: notification.message,
            icon: '/icon.png',
            tag: notification.id
        });
        
        // Update UI
        this.renderNotification(notification);
    }

    renderNotification(notification) {
        const container = document.getElementById('notificationsContainer');
        if (!container) return;

        const notificationElement = this.createNotificationElement(notification);
        container.insertBefore(notificationElement, container.firstChild);
    }

    createNotificationElement(notification) {
        const element = document.createElement('div');
        element.className = `notification-item ${notification.unread ? 'unread' : ''}`;
        element.innerHTML = `
            <div class="notification-avatar">
                <img src="${notification.senderAvatar}" alt="${notification.senderName}">
            </div>
            <div class="notification-content">
                <div class="notification-text">${notification.message}</div>
                <div class="notification-time">${this.formatTime(notification.timestamp)}</div>
            </div>
            ${notification.unread ? '<div class="notification-dot"></div>' : ''}
        `;
        
        element.addEventListener('click', () => {
            this.handleNotificationClick(notification);
        });
        
        return element;
    }

    handleNotificationClick(notification) {
        this.markAsRead(notification.id);
        
        // Navigate to relevant content
        switch (notification.type) {
            case 'like':
            case 'comment':
                this.navigateToPost(notification.postId);
                break;
            case 'follow':
                this.navigateToProfile(notification.senderId);
                break;
            case 'message':
                this.navigateToChat(notification.senderId);
                break;
        }
    }

    formatTime(timestamp) {
        const now = new Date();
        const time = new Date(timestamp);
        const diff = now - time;
        
        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);
        
        if (minutes < 1) return 'Şimdi';
        if (minutes < 60) return `${minutes} dk önce`;
        if (hours < 24) return `${hours} sa önce`;
        if (days < 7) return `${days} gün önce`;
        
        return time.toLocaleDateString('tr-TR');
    }
}

// ===== INITIALIZATION =====
const appState = new AppState();
const apiService = new ApiService(CONFIG.API_BASE_URL);
const liveStreamManager = new LiveStreamManager();
const postManager = new PostManager();
const locationService = new LocationService();
const notificationManager = new NotificationManager();

// Initialize the application
document.addEventListener('DOMContentLoaded', async () => {
    try {
        await initializeApp();
    } catch (error) {
        console.error('Failed to initialize app:', error);
        showError('Uygulama başlatılamadı. Lütfen sayfayı yenileyin.');
    }
});

async function initializeApp() {
    // Check if user is logged in
    const isValidSession = await appState.validateSession();
    
    if (isValidSession) {
        showMainApp();
        await loadInitialData();
    } else {
        showAuthScreen();
    }

    // Initialize services
    await notificationManager.initialize();
    locationService.startWatching();

    // Setup global event listeners
    setupGlobalEventListeners();
}

function showMainApp() {
    document.getElementById('splashScreen').style.display = 'none';
    document.getElementById('authScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'block';
    
    // Update user interface
    updateUserInterface();
}

function showAuthScreen() {
    document.getElementById('splashScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'none';
    document.getElementById('authScreen').style.display = 'flex';
}

async function loadInitialData() {
    try {
        // Load feed
        const feed = await apiService.getFeed();
        appState.feed = feed;
        renderFeed();

        // Load notifications
        await notificationManager.loadNotifications();

        // Load user profile
        const userProfile = await apiService.getUserProfile(appState.currentUser.id);
        appState.currentUser = { ...appState.currentUser, ...userProfile };
        updateUserProfile();

        // Load stories
        await loadStories();

    } catch (error) {
        console.error('Failed to load initial data:', error);
    }
}

function setupGlobalEventListeners() {
    // Global search
    const searchInput = document.getElementById('globalSearch');
    if (searchInput) {
        searchInput.addEventListener('input', debounce(handleGlobalSearch, 300));
    }

    // Navigation
    document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.addEventListener('click', handleNavigation);
    });

    // Theme toggle
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => appState.toggleTheme());
    }

    // Online/offline indicators
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Error handling
    window.addEventListener('error', handleGlobalError);
    window.addEventListener('unhandledrejection', handlePromiseRejection);
}

// Utility functions
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    if (!toast) return;

    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.classList.add('show');

    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

function showError(message) {
    showToast(message, 'error');
}

function showSuccess(message) {
    showToast(message, 'success');
}

function formatNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + 'M';
    } else if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num.toString();
}

// Export for global access
window.appState = appState;
window.apiService = apiService;
window.liveStreamManager = liveStreamManager;
window.postManager = postManager;

console.log('Agrolink uygulaması başlatıldı');