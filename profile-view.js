// Professional Profile View Module with Advanced Features
(function() {
    // Constants
    const CACHE_TTL = 300000; // 5 minutes
    const DEBOUNCE_DELAY = 300;
    const MAX_FOLLOWERS_DISPLAY = 5;
    
    // Private variables
    let profileViewInstance = null;
    let onlineUsers = {};
    let profileCache = new Map();
    let followStatusCache = new Map();
    let statsCache = new Map();
    let debounceTimers = {};

    // Debug function with timestamp and log levels
    function debug(message, level = 'info') {
        const timestamp = new Date().toISOString();
        const styles = {
            info: 'color: #3498db;',
            warn: 'color: #f39c12;',
            error: 'color: #e74c3c;',
            success: 'color: #2ecc71;'
        };
        console.log(`%c[ProfileView ${timestamp}] ${message}`, styles[level]);
    }

    // Performance tracker
    const perf = {
        start: (name) => {
            perf[name] = performance.now();
        },
        end: (name) => {
            const duration = performance.now() - perf[name];
            debug(`⏱️ ${name} took ${duration.toFixed(2)}ms`, 'info');
            return duration;
        }
    };

    // Main ProfileView class
    class ProfileView {
        constructor(supabaseClient, currentUserId) {
            perf.start('constructor');
            debug('Initializing ProfileView', 'info');
            
            if (!supabaseClient) throw new Error("Supabase client is required");
            if (!currentUserId) throw new Error("Current user ID is required");

            this.supabase = supabaseClient;
            this.currentUserId = currentUserId;
            this.profileContainer = null;
            this.currentProfileId = null;
            this.isProfileEditable = false;
            this.realtimeChannels = {};
            
            this.initProfileContainer();
            this.setupEventListeners();
            this.patchUserList();
            this.setupRealTimeUpdates();
            
            debug('ProfileView instance created successfully', 'success');
            perf.end('constructor');
        }
        
        async setupRealTimeUpdates() {
            debug('Setting up realtime updates', 'info');
            
            // Presence channel for online status
            this.realtimeChannels.presence = this.supabase.channel('profile-presence');
            
            // Subscribe to presence changes
            this.realtimeChannels.presence
                .on('presence', { event: 'sync' }, () => {
                    const state = this.realtimeChannels.presence.presenceState();
                    onlineUsers = {};
                    Object.keys(state).forEach(key => {
                        state[key].forEach(user => {
                            onlineUsers[user.user_id] = true;
                        });
                    });
                    this.updateOnlineStatus();
                })
                .subscribe(async (status) => {
                    if (status === 'SUBSCRIBED') {
                        await this.realtimeChannels.presence.track({
                            user_id: this.currentUserId,
                            online_at: new Date().toISOString()
                        });
                    }
                });

            // Stats update channel
            this.realtimeChannels.stats = this.supabase.channel('profile-stats')
                .on('postgres_changes', {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'user_stats'
                }, (payload) => {
                    const newStats = payload.new;
                    statsCache.set(newStats.user_id, {
                        data: newStats,
                        timestamp: Date.now()
                    });
                    
                    if (this.currentProfileId === newStats.user_id) {
                        this.updateStatsUI(newStats);
                    }
                })
                .subscribe();
        }
        
        initProfileContainer() {
            perf.start('initProfileContainer');
            debug('Initializing profile container', 'info');
            
            // Create container with modern glass morphism design
            this.profileContainer = document.createElement('div');
            this.profileContainer.className = 'profile-view-container';
            this.profileContainer.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                z-index: 2000;
                opacity: 0;
                pointer-events: none;
                transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
                display: flex;
                align-items: center;
                justify-content: center;
                backdrop-filter: blur(10px);
            `;
            
            this.profileContainer.innerHTML = `
                <div class="profile-overlay" style="
                    position: absolute;
                    top: 0;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    background: rgba(0, 0, 0, 0.6);
                "></div>
                
                <div class="profile-content" style="
                    position: relative;
                    width: 90%;
                    max-width: 800px;
                    max-height: 90vh;
                    overflow-y: auto;
                    background: rgba(255, 255, 255, 0.15);
                    border-radius: 20px;
                    padding: 30px;
                    z-index: 1;
                    backdrop-filter: blur(16px);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
                    -webkit-overflow-scrolling: touch;
                    scrollbar-width: thin;
                    scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
                ">
                    <style>
                        .profile-content::-webkit-scrollbar {
                            width: 6px;
                        }
                        .profile-content::-webkit-scrollbar-track {
                            background: transparent;
                        }
                        .profile-content::-webkit-scrollbar-thumb {
                            background-color: rgba(255, 255, 255, 0.3);
                            border-radius: 3px;
                        }
                    </style>
                    <!-- Profile Cover -->
                    <div id="profileCover" style="
                        position: absolute;
                        top: 0;
                        left: 0;
                        right: 0;
                        height: 200px;
                        background: linear-gradient(135deg, rgba(0,123,255,0.8), rgba(0,86,179,0.8));
                        overflow: hidden;
                    ">
                        <img src="" style="
                            width: 100%;
                            height: 100%;
                            object-fit: cover;
                        ">
                    </div>
                    
                    <!-- Close Button -->
                    <button class="profile-close-button" style="
                        position: absolute;
                        top: 20px;
                        right: 20px;
                        background: rgba(255,255,255,0.2);
                        border: none;
                        width: 40px;
                        height: 40px;
                        border-radius: 50%;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        color: white;
                        font-size: 18px;
                        transition: all 0.2s ease;
                        z-index: 10;
                    ">
                        <i class="fas fa-times"></i>
                    </button>
                    
                    <!-- Edit Profile Button -->
                    <button id="editProfileButton" style="
                        position: absolute;
                        top: 20px;
                        right: 70px;
                        background: rgba(255,255,255,0.2);
                        border: none;
                        width: 40px;
                        height: 40px;
                        border-radius: 50%;
                        cursor: pointer;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        color: white;
                        font-size: 18px;
                        transition: all 0.2s ease;
                        z-index: 10;
                    ">
                        <i class="fas fa-edit"></i>
                    </button>
                    
                    <!-- Profile Header -->
                    <div class="profile-header" style="
                        position: relative;
                        z-index: 2;
                        margin-top: 20px;
                        text-align: center;
                    ">
                        <div id="profileAvatar" style="
                            width: 120px;
                            height: 120px;
                            margin: 0 auto 15px;
                            border-radius: 50%;
                            overflow: hidden;
                            border: 3px solid rgba(255,255,255,0.3);
                            box-shadow: 0 4px 20px rgba(0,0,0,0.2);
                            position: relative;
                        ">
                            <img src="" style="width: 100%; height: 100%; object-fit: cover;">
                            <div class="profile-status-indicator" style="
                                position: absolute;
                                bottom: 5px;
                                right: 5px;
                                width: 15px;
                                height: 15px;
                                border-radius: 50%;
                                background-color: #999;
                                border: 2px solid rgba(255,255,255,0.3);
                            "></div>
                            <div class="profile-status-glow" style="
                                position: absolute;
                                bottom: 0;
                                right: 0;
                                width: 25px;
                                height: 25px;
                                border-radius: 50%;
                                background: radial-gradient(circle, rgba(76,175,80,0.8) 0%, rgba(76,175,80,0) 70%);
                                opacity: 0;
                                transition: opacity 0.3s ease;
                            "></div>
                        </div>
                        <h2 id="profileName" style="
                            margin: 0;
                            font-size: 28px;
                            font-weight: 600;
                            color: white;
                            text-shadow: 0 2px 4px rgba(0,0,0,0.2);
                        "></h2>
                        <p id="profileTitle" style="
                            margin: 8px 0 0;
                            color: rgba(255,255,255,0.8);
                            font-size: 16px;
                        "></p>
                        <div id="profileVerifiedBadge" style="
                            display: inline-flex;
                            align-items: center;
                            gap: 4px;
                            margin-top: 8px;
                            padding: 4px 8px;
                            background: rgba(0, 123, 255, 0.2);
                            border-radius: 12px;
                            font-size: 12px;
                            color: #3498db;
                        ">
                            <i class="fas fa-check-circle"></i>
                            <span>Verified</span>
                        </div>
                    </div>
                    
                    <!-- Profile Actions -->
                    <div class="profile-actions" style="
                        display: flex;
                        gap: 12px;
                        justify-content: center;
                        margin: 30px 0;
                    ">
                        <button id="followButton" class="profile-action-button" style="
                            padding: 12px 24px;
                            border: none;
                            border-radius: 10px;
                            background: linear-gradient(135deg, rgba(0,123,255,0.8), rgba(0,86,179,0.8));
                            color: white;
                            cursor: pointer;
                            font-weight: 500;
                            font-size: 15px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            gap: 8px;
                            transition: all 0.2s ease;
                        ">
                            <i class="fas fa-user-plus"></i>
                            <span>Follow</span>
                        </button>
                        <button id="messageButton" class="profile-action-button" style="
                            padding: 12px 24px;
                            border: none;
                            border-radius: 10px;
                            background: rgba(255,255,255,0.2);
                            color: white;
                            cursor: pointer;
                            font-weight: 500;
                            font-size: 15px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            gap: 8px;
                            transition: all 0.2s ease;
                        ">
                            <i class="fas fa-comment"></i>
                            <span>Message</span>
                        </button>
                    </div>
                    
                    <!-- Profile Stats -->
                    <div class="profile-stats" style="
                        display: grid;
                        grid-template-columns: repeat(3, 1fr);
                        gap: 15px;
                        margin: 0 0 30px;
                    ">
                        <div class="profile-stat" id="followersStat" style="
                            background: rgba(255,255,255,0.1);
                            padding: 15px;
                            border-radius: 10px;
                            text-align: center;
                        ">
                            <div id="statFollowers" style="
                                font-size: 26px;
                                font-weight: 600;
                                color: white;
                                margin-bottom: 5px;
                            ">0</div>
                            <div style="
                                color: rgba(255,255,255,0.7);
                                font-size: 14px;
                            ">Followers</div>
                        </div>
                        <div class="profile-stat" id="followingStat" style="
                            background: rgba(255,255,255,0.1);
                            padding: 15px;
                            border-radius: 10px;
                            text-align: center;
                        ">
                            <div id="statFollowing" style="
                                font-size: 26px;
                                font-weight: 600;
                                color: white;
                                margin-bottom: 5px;
                            ">0</div>
                            <div style="
                                color: rgba(255,255,255,0.7);
                                font-size: 14px;
                            ">Following</div>
                        </div>
                        <div class="profile-stat" id="messagesStat" style="
                            background: rgba(255,255,255,0.1);
                            padding: 15px;
                            border-radius: 10px;
                            text-align: center;
                        ">
                            <div id="statMessages" style="
                                font-size: 26px;
                                font-weight: 600;
                                color: white;
                                margin-bottom: 5px;
                            ">0</div>
                            <div style="
                                color: rgba(255,255,255,0.7);
                                font-size: 14px;
                            ">Messages</div>
                        </div>
                    </div>

                    <!-- Recent Followers -->
                    <div id="profileRecentFollowers" style="
                        display: flex;
                        gap: 10px;
                        margin-bottom: 30px;
                        flex-wrap: wrap;
                    "></div>
                    
                    <!-- Profile Bio -->
                    <div class="profile-bio" style="
                        background: rgba(255,255,255,0.1);
                        padding: 20px;
                        border-radius: 12px;
                        margin-bottom: 30px;
                    ">
                        <h3 style="
                            margin: 0 0 15px;
                            color: white;
                            font-size: 18px;
                            display: flex;
                            align-items: center;
                            gap: 8px;
                        ">
                            <i class="fas fa-user" style="opacity: 0.7;"></i>
                            <span>About</span>
                        </h3>
                        <div id="profileBio" style="
                            color: rgba(255,255,255,0.9);
                            line-height: 1.6;
                            font-size: 15px;
                        "></div>

                        <!-- Job Info -->
                        <div class="profile-job-info" style="
                            margin-top: 20px;
                            display: flex;
                            flex-direction: column;
                            gap: 10px;
                        ">
                            <div id="profileJobTitle" style="
                                display: flex;
                                align-items: center;
                                gap: 8px;
                                color: rgba(255,255,255,0.9);
                            ">
                                <i class="fas fa-briefcase" style="opacity: 0.7;"></i>
                                <span></span>
                            </div>
                            <div id="profileCompany" style="
                                display: flex;
                                align-items: center;
                                gap: 8px;
                                color: rgba(255,255,255,0.9);
                            ">
                                <i class="fas fa-building" style="opacity: 0.7;"></i>
                                <span></span>
                            </div>
                        </div>

                        <!-- Skills Section -->
                        <div class="profile-skills" style="
                            margin-top: 20px;
                            background: rgba(255,255,255,0.1);
                            padding: 20px;
                            border-radius: 12px;
                        ">
                            <h3 style="
                                margin: 0 0 15px;
                                color: white;
                                font-size: 18px;
                                display: flex;
                                align-items: center;
                                gap: 8px;
                            ">
                                <i class="fas fa-code" style="opacity: 0.7;"></i>
                                <span>Skills</span>
                            </h3>
                            <div id="profileSkills" style="
                                display: flex;
                                flex-wrap: wrap;
                                gap: 8px;
                            "></div>
                        </div>
                    </div>
                    
                    <!-- Loading State -->
                    <div class="profile-loading" style="
                        position: absolute;
                        top: 0;
                        left: 0;
                        right: 0;
                        bottom: 0;
                        background: rgba(0,0,0,0.5);
                        backdrop-filter: blur(5px);
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        z-index: 10;
                        opacity: 0;
                        pointer-events: none;
                        transition: opacity 0.3s ease;
                    ">
                        <div class="loading-spinner" style="
                            width: 50px;
                            height: 50px;
                            border: 4px solid rgba(255,255,255,0.2);
                            border-top-color: white;
                            border-radius: 50%;
                            animation: spin 1s linear infinite;
                        "></div>
                    </div>
                </div>
                
                <style>
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                </style>
            `;
            
            // Add the container to the document body
            document.body.appendChild(this.profileContainer);
            
            debug('Profile container initialized', 'success');
            perf.end('initProfileContainer');
        }
        
        setupEventListeners() {
            perf.start('setupEventListeners');
            debug('Setting up event listeners', 'info');
            
            // Close button click
            this.profileContainer.querySelector('.profile-close-button').addEventListener('click', () => {
                this.hideProfile();
            });
            
            // Overlay click
            this.profileContainer.querySelector('.profile-overlay').addEventListener('click', () => {
                this.hideProfile();
            });
            
            // Follow button click with debounce
            this.profileContainer.querySelector('#followButton').addEventListener('click', () => {
                if (!this.currentProfileId) return;
                
                // Debounce to prevent rapid clicks
                if (debounceTimers.follow) {
                    clearTimeout(debounceTimers.follow);
                }
                
                debounceTimers.follow = setTimeout(() => {
                    this.toggleFollow();
                }, DEBOUNCE_DELAY);
            });
            
            // Message button click
            this.profileContainer.querySelector('#messageButton').addEventListener('click', () => {
                if (this.currentProfileId && typeof window.selectUser === 'function') {
                    this.hideProfile();
                    window.selectUser({ id: this.currentProfileId });
                }
            });
            
            // Stats click handlers
            this.profileContainer.querySelector('#followersStat').addEventListener('click', () => {
                this.showFollowersList();
            });
            
            this.profileContainer.querySelector('#followingStat').addEventListener('click', () => {
                this.showFollowingList();
            });
            
            perf.end('setupEventListeners');
        }

        async toggleFollow() {
            if (!this.currentProfileId) return;
            
            const button = this.profileContainer.querySelector('#followButton');
            const currentFollowStatus = followStatusCache.get(this.currentProfileId);
            
            // Prevent multiple clicks while operation is in progress
            if (button.dataset.processing === 'true') {
                debug('Follow operation already in progress', 'warn');
                return;
            }
            
            // Set processing state
            button.dataset.processing = 'true';
            const originalButtonContent = button.innerHTML;
            
            // Show loading state
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Processing...';
            button.style.opacity = '0.7';
            button.style.cursor = 'not-allowed';
                
                // Get current stats before making changes
                const currentStats = await this.loadUserStats(this.currentProfileId, true);
                
            try {
                const newFollowStatus = !currentFollowStatus;
                let retryCount = 0;
                const maxRetries = 3;
                let success = false;
                
                while (retryCount < maxRetries && !success) {
                    try {
                if (newFollowStatus) {
                    // Follow logic
                    const { error } = await this.supabase
                        .from('follows')
                        .insert([{
                            follower_id: this.currentUserId,
                            following_id: this.currentProfileId,
                            created_at: new Date().toISOString()
                        }]);
                    
                    if (error) throw error;
                } else {
                    // Unfollow logic
                    const { error } = await this.supabase
                        .from('follows')
                        .delete()
                        .eq('follower_id', this.currentUserId)
                        .eq('following_id', this.currentProfileId);
                    
                    if (error) throw error;
                        }
                        
                        success = true;
                    } catch (error) {
                        retryCount++;
                        if (retryCount === maxRetries) {
                            throw error;
                        }
                        // Wait before retrying
                        await new Promise(resolve => setTimeout(resolve, 1000 * retryCount));
                    }
                }
                    
                    // Update local cache
                followStatusCache.set(this.currentProfileId, newFollowStatus);
                    
                    // Update stats in database and UI immediately
                await this.updateStatsAfterFollowChange(newFollowStatus, currentStats);
                
                // Update button state
                this.updateFollowButton(newFollowStatus);
                
                // Show success feedback
                button.innerHTML = `<i class="fas fa-check"></i> ${newFollowStatus ? 'Following' : 'Follow'}`;
                button.style.backgroundColor = newFollowStatus ? '#4CAF50' : '#2196F3';
                
                // Reset button state after 2 seconds
                setTimeout(() => {
                    this.updateFollowButton(newFollowStatus);
                }, 2000);
                
            } catch (error) {
                console.error('Error toggling follow:', error);
                
                // Show error feedback
                button.innerHTML = `<i class="fas fa-exclamation-circle"></i> ${currentFollowStatus ? 'Unfollow Failed' : 'Follow Failed'}`;
                button.style.backgroundColor = '#f44336';
                
                // Show error notification
                this.showNotification(
                    currentFollowStatus ? 'Failed to unfollow' : 'Failed to follow',
                    error.message,
                    'error'
                );
                
                // Revert after 2 seconds
                setTimeout(() => {
                    this.updateFollowButton(currentFollowStatus);
                }, 2000);
                
            } finally {
                // Reset processing state after a delay
                setTimeout(() => {
                button.dataset.processing = 'false';
                    button.style.opacity = '1';
                    button.style.cursor = 'pointer';
                }, 2000);
            }
        }
        
        async updateStatsAfterFollowChange(isFollowing, currentStats) {
            try {
                // Update both stats in parallel
                const [followingResult, followersResult] = await Promise.all([
                    this.supabase.rpc('increment_following_count', {
                        in_amount: isFollowing ? 1 : -1,
                        in_user_id: this.currentUserId
                    }),
                    this.supabase.rpc('increment_followers_count', {
                        in_amount: isFollowing ? 1 : -1,
                        in_user_id: this.currentProfileId
                    })
                ]);
                
                if (followingResult.error) throw followingResult.error;
                if (followersResult.error) throw followersResult.error;

                // Force refresh stats for both users to ensure accuracy
                const [currentUserStats, profileStats] = await Promise.all([
                    this.loadUserStats(this.currentUserId, true),
                    this.loadUserStats(this.currentProfileId, true)
                ]);
                
                // Update UI with fresh stats
                this.updateStatsUI(profileStats);
                
            } catch (error) {
                console.error('Error updating stats:', error);
                throw error;
            }
        }

        patchUserList() {
            debug('Patching user list', 'info');
            const originalRenderUserList = window.renderUserList;
            
            window.renderUserList = function(users) {
                debug('renderUserList called', 'info');
                
                // Call original function first if it exists
                if (originalRenderUserList) {
                    originalRenderUserList(users);
                } else {
                    const userList = document.getElementById('userList');
                    if (!userList) return;
                    userList.innerHTML = '';
                }

                // Add click handlers to avatars
                const avatars = document.querySelectorAll('.user-avatar[role="button"]');
                debug(`Found ${avatars.length} avatars`, 'info');
                
                avatars.forEach(avatar => {
                    avatar.style.cursor = 'pointer';
                    avatar.onclick = (e) => {
                        debug('Avatar clicked', 'info');
                        e.preventDefault();
                        e.stopPropagation();
                        
                        const userCard = avatar.closest('.user-card');
                        if (userCard && userCard.dataset.userId) {
                            debug(`User ID: ${userCard.dataset.userId}`, 'info');
                            const profileView = window.ProfileView.getInstance();
                            if (profileView) {
                                profileView.showProfile(userCard.dataset.userId);
                            } else {
                                debug('ProfileView instance not found, trying to initialize', 'warn');
                                // Try to initialize ProfileView if not already initialized
                                if (window.supabaseClient && window.currentUserId) {
                                    window.ProfileView.initialize(window.supabaseClient, window.currentUserId);
                                    const newProfileView = window.ProfileView.getInstance();
                                    if (newProfileView) {
                                        newProfileView.showProfile(userCard.dataset.userId);
                                    }
                                }
                            }
                        }
                    };
                });
            };
        }
        
        async showProfile(userId) {
            perf.start('showProfile');
            debug(`Showing profile for user: ${userId}`, 'info');
            
            // Show the profile container
            this.profileContainer.style.display = 'flex';
            this.profileContainer.style.opacity = '1';
            this.profileContainer.style.pointerEvents = 'auto';
            document.body.style.overflow = 'hidden';
            
            // Show loading state
            this.showLoading(true);
            
            // Reset UI
            this.profileContainer.querySelector('#profileName').textContent = 'Loading...';
            this.profileContainer.querySelector('#profileTitle').textContent = '';
            this.profileContainer.querySelector('#profileBio').textContent = '';
            this.profileContainer.querySelector('#profileVerifiedBadge').style.display = 'none';
            
            // Set current profile ID and check if it's the current user's profile
            this.currentProfileId = userId;
            this.isProfileEditable = userId === this.currentUserId;
            this.profileContainer.querySelector('#editProfileButton').style.display = 
                this.isProfileEditable ? 'flex' : 'none';
            
            try {
                // Load user data, profile data, and stats in parallel
                const [userData, profileData, statsData] = await Promise.all([
                    this.loadUserData(userId),
                    this.loadProfileData(userId),
                    this.loadUserStats(userId)
                ]);
                
                // Update UI with all loaded data
                this.updateProfileUI(userData, profileData);
                this.updateStatsUI(statsData);
                
                // Load additional data that's less critical
                Promise.all([
                    this.loadRecentFollowers(userId),
                    this.loadFollowStatus(userId)
                ]).catch(error => {
                    debug('Failed to load additional profile data:', 'error', error);
                });
                
                debug('Profile UI updated', 'success');
                
            } catch (error) {
                console.error('Error loading profile:', error);
                this.showErrorState(error);
            } finally {
                this.showLoading(false);
                perf.end('showProfile');
            }
        }
        
        async loadUserData(userId) {
            // Check cache first
            if (profileCache.has(userId)) {
                const cached = profileCache.get(userId);
                if (Date.now() - cached.timestamp < CACHE_TTL) {
                    debug(`Using cached user data for ${userId}`, 'info');
                    return cached.data;
                }
            }
            
            debug(`Loading user data for ${userId}`, 'info');
            const { data: user, error } = await this.supabase
                .from('users')
                .select('id, name, status, avatar_url, lastonline, role, profile_cover_url, verified')
                .eq('id', userId)
                .single();
            
            if (error) throw error;
            
            // Update cache
            profileCache.set(userId, {
                data: user,
                timestamp: Date.now()
            });
            
            return user;
        }
        
        async loadProfileData(userId) {
            // Check cache first
            if (profileCache.has(`profile_${userId}`)) {
                const cached = profileCache.get(`profile_${userId}`);
                if (Date.now() - cached.timestamp < CACHE_TTL) {
                    debug(`Using cached profile data for ${userId}`, 'info');
                    return cached.data;
                }
            }
            
            debug(`Loading profile data for ${userId}`, 'info');
            let profile = {};
            
            try {
                const { data: profileData, error } = await this.supabase
                    .from('user_profiles')
                    .select('bio, location, website, user_id, job_title, company, skills, social_links')
                    .eq('user_id', userId)
                    .single();
                
                if (!error && profileData) {
                    profile = profileData;
                } else if (userId === this.currentUserId) {
                    // Only create profile if it's the current user
                    const { data: newProfile, error: insertError } = await this.supabase
                        .from('user_profiles')
                        .insert([{ user_id: userId }])
                        .select('bio, location, website, user_id, job_title, company, skills, social_links')
                        .single();
                    
                    if (!insertError && newProfile) {
                        profile = newProfile;
                    }
                }
            } catch (error) {
                debug(`Profile data error (non-critical): ${error.message}`, 'warn');
            }
            
            // Update cache
            profileCache.set(`profile_${userId}`, {
                data: profile,
                timestamp: Date.now()
            });
            
            return profile;
        }
        
        async loadUserStats(userId, forceRefresh = false) {
            // Check cache first
            if (!forceRefresh && statsCache.has(userId)) {
                const cached = statsCache.get(userId);
                if (Date.now() - cached.timestamp < CACHE_TTL) {
                    debug(`Using cached stats for ${userId}`, 'info');
                    return cached.data;
                }
            }
            
            debug(`Loading stats for ${userId}`, 'info');
            let stats = { followers_count: 0, following_count: 0, messages_count: 0 };
            
            try {
                // Always get the actual counts from the follows table first
                    const [followers, following, messages] = await Promise.all([
                        this.supabase
                            .from('follows')
                            .select('*', { count: 'exact', head: true })
                            .eq('following_id', userId),
                        
                        this.supabase
                            .from('follows')
                            .select('*', { count: 'exact', head: true })
                            .eq('follower_id', userId),
                            
                        this.supabase
                            .from('messages')
                            .select('*', { count: 'exact', head: true })
                            .or(`sender_id.eq.${userId},receiver_id.eq.${userId}`)
                    ]);
                    
                    stats = {
                        followers_count: followers.count || 0,
                        following_count: following.count || 0,
                        messages_count: messages.count || 0
                    };
                    
                // Update stats table to ensure consistency
                    await this.supabase
                        .from('user_stats')
                        .upsert({
                            user_id: userId,
                            ...stats,
                            last_updated: new Date().toISOString()
                        });
                
            } catch (error) {
                debug(`Stats error (non-critical): ${error.message}`, 'warn');
            }
            
            // Update cache
            statsCache.set(userId, {
                data: stats,
                timestamp: Date.now()
            });
            
            return stats;
        }
        
        async loadFollowStatus(userId) {
            // Check cache first
            if (followStatusCache.has(userId)) {
                const cached = followStatusCache.get(userId);
                if (Date.now() - cached.timestamp < CACHE_TTL) {
                    debug(`Using cached follow status for ${userId}`, 'info');
                    return cached.data;
                }
            }
            
            debug(`Loading follow status for ${userId}`, 'info');
            let followStatus = false;
            
            try {
                const { data, error } = await this.supabase
                    .from('follows')
                    .select('id')
                    .eq('follower_id', this.currentUserId)
                    .eq('following_id', userId)
                    .single();
                
                if (!error && data) {
                    followStatus = true;
                }
            } catch (error) {
                debug(`Follow status error (non-critical): ${error.message}`, 'warn');
            }
            
            // Update cache
            followStatusCache.set(userId, {
                data: followStatus,
                timestamp: Date.now()
            });
            
            // Update UI
            this.updateFollowButton(followStatus);
            
            return followStatus;
        }
        
        async loadRecentFollowers(userId, limit = MAX_FOLLOWERS_DISPLAY) {
            debug(`Loading recent followers for ${userId}`, 'info');
            
            try {
                // First get the follower IDs
                const { data: follows, error: followsError } = await this.supabase
                    .from('follows')
                    .select('follower_id, created_at')
                    .eq('following_id', userId)
                    .order('created_at', { ascending: false })
                    .limit(limit);
                
                if (followsError) throw followsError;
                
                if (!follows || follows.length === 0) {
                    this.updateRecentFollowersUI([]);
                    return;
                }

                // Then get the user data for each follower
                const followerIds = follows.map(f => f.follower_id);
                const { data: users, error: usersError } = await this.supabase
                    .from('users')
                    .select('id, name, avatar_url')
                    .in('id', followerIds);
                
                if (usersError) throw usersError;

                // Combine the data
                const followers = follows.map(follow => {
                    const user = users.find(u => u.id === follow.follower_id);
                    return {
                        follower: user || { id: follow.follower_id, name: 'Unknown User', avatar_url: null },
                        created_at: follow.created_at
                    };
                });
                
                this.updateRecentFollowersUI(followers);
                
            } catch (error) {
                debug(`Failed to load recent followers: ${error.message}`, 'warn');
                // Show empty state in UI
                this.updateRecentFollowersUI([]);
            }
        }
        
        updateProfileUI(user, profile) {
            perf.start('updateProfileUI');
            debug('Updating profile UI', 'info');
            
            // Cover photo
            const coverImg = this.profileContainer.querySelector('#profileCover img');
            coverImg.src = user.profile_cover_url || 'https://source.unsplash.com/random/800x300/?abstract';
            
            // Avatar
            const avatarImg = this.profileContainer.querySelector('#profileAvatar img');
            avatarImg.src = user.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&background=random&color=fff`;
            
            // Name and title
            this.profileContainer.querySelector('#profileName').textContent = user.name;
            this.profileContainer.querySelector('#profileTitle').textContent = profile.job_title || 'Team Member';
            
            // Verified badge
            this.profileContainer.querySelector('#profileVerifiedBadge').style.display = 
                user.verified ? 'inline-flex' : 'none';
            
            // Bio
            this.profileContainer.querySelector('#profileBio').textContent = 
                profile.bio || (this.isProfileEditable ? 'Click "Edit Profile" to add a bio' : 'No bio available');
            
            // Job info
            const jobTitleEl = this.profileContainer.querySelector('#profileJobTitle span');
            const companyEl = this.profileContainer.querySelector('#profileCompany span');
            
            jobTitleEl.textContent = profile.job_title || 'Not specified';
            companyEl.textContent = profile.company || 'Not specified';
            
            // Skills
            this.updateSkillsUI(profile.skills || []);
            
            // Online status
            this.updateOnlineStatus();
            
            perf.end('updateProfileUI');
        }
        
        updateStatsUI(stats) {
            this.profileContainer.querySelector('#statFollowers').textContent = 
                stats.followers_count || '0';
            this.profileContainer.querySelector('#statFollowing').textContent = 
                stats.following_count || '0';
            this.profileContainer.querySelector('#statMessages').textContent = 
                stats.messages_count || '0';
        }
        
        updateSkillsUI(skills) {
            const skillsContainer = this.profileContainer.querySelector('#profileSkills');
            skillsContainer.innerHTML = '';
            
            if (skills.length === 0) {
                const emptyMsg = document.createElement('div');
                emptyMsg.textContent = this.isProfileEditable ? 
                    'Add your skills in profile settings' : 'No skills listed';
                emptyMsg.style.color = 'rgba(255,255,255,0.5)';
                skillsContainer.appendChild(emptyMsg);
                return;
            }
            
            skills.forEach(skill => {
                const skillTag = document.createElement('div');
                skillTag.className = 'skill-tag';
                skillTag.style.cssText = `
                    padding: 4px 12px;
                    background: rgba(0, 123, 255, 0.2);
                    border-radius: 12px;
                    font-size: 13px;
                    color: #3498db;
                `;
                skillTag.textContent = skill;
                skillsContainer.appendChild(skillTag);
            });
        }
        
        updateRecentFollowersUI(followers) {
            const container = this.profileContainer.querySelector('#profileRecentFollowers');
            container.innerHTML = '';
            
            if (!followers || followers.length === 0) {
                const emptyMsg = document.createElement('div');
                emptyMsg.textContent = 'No followers yet';
                emptyMsg.style.color = 'rgba(255,255,255,0.5)';
                container.appendChild(emptyMsg);
                return;
            }
            
            followers.forEach(follower => {
                const avatar = document.createElement('div');
                avatar.className = 'follower-avatar';
                avatar.style.cssText = `
                    width: 40px;
                    height: 40px;
                    border-radius: 50%;
                    background: rgba(255,255,255,0.1);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    overflow: hidden;
                    cursor: pointer;
                `;
                
                if (follower.follower.avatar_url) {
                    const img = document.createElement('img');
                    img.src = follower.follower.avatar_url;
                    img.style.cssText = `
                        width: 100%;
                        height: 100%;
                        object-fit: cover;
                    `;
                    avatar.appendChild(img);
                } else {
                    const icon = document.createElement('i');
                    icon.className = 'fas fa-user';
                    icon.style.color = 'rgba(255,255,255,0.5)';
                    avatar.appendChild(icon);
                }
                
                avatar.title = follower.follower.name;
                avatar.addEventListener('click', () => {
                    this.showProfile(follower.follower.id);
                });
                
                container.appendChild(avatar);
            });
        }
        
        updateFollowButton(isFollowing) {
            const button = this.profileContainer.querySelector('#followButton');
            if (!button) return;
            
            // Reset any error states
            button.dataset.processing = 'false';
            
            if (isFollowing) {
                button.innerHTML = '<i class="fas fa-user-check"></i> Following';
                button.style.background = 'linear-gradient(135deg, rgba(255,255,255,0.2), rgba(255,255,255,0.1))';
            } else {
                button.innerHTML = '<i class="fas fa-user-plus"></i> Follow';
                button.style.background = 'linear-gradient(135deg, rgba(0,123,255,0.8), rgba(0,86,179,0.8))';
            }
            
            // Hide follow button if it's the current user's profile
            button.style.display = this.isProfileEditable ? 'none' : 'flex';
        }
        
        updateOnlineStatus() {
            const statusIndicator = this.profileContainer.querySelector('.profile-status-indicator');
            const statusGlow = this.profileContainer.querySelector('.profile-status-glow');
            
            const user = profileCache.get(this.currentProfileId)?.data;
            if (!user) return;
            
            const isOnline = onlineUsers[user.id] || 
                (user.status === 'online' && user.lastonline && 
                (Date.now() - new Date(user.lastonline).getTime()) < 300000);
            
            if (isOnline) {
                statusIndicator.style.backgroundColor = '#4CAF50';
                statusGlow.style.color = '#4CAF50';
                statusGlow.style.opacity = '0.8';
            } else {
                statusIndicator.style.backgroundColor = '#999';
                statusGlow.style.opacity = '0';
            }
        }
        
        showErrorState(error) {
            this.profileContainer.querySelector('#profileName').textContent = 'Error loading profile';
            this.profileContainer.querySelector('#profileBio').textContent = 
                error.message || 'Failed to load profile data. Please try again.';
            
            const avatarImg = this.profileContainer.querySelector('#profileAvatar img');
            avatarImg.src = `https://ui-avatars.com/api/?name=Error&background=ff0000&color=fff`;
            
            this.showNotification('Profile Error', error.message || 'Failed to load profile', 'error');
        }
        
        showLoading(show) {
            const loadingElement = this.profileContainer.querySelector('.profile-loading');
            if (show) {
                loadingElement.style.opacity = '1';
                loadingElement.style.pointerEvents = 'auto';
            } else {
                loadingElement.style.opacity = '0';
                loadingElement.style.pointerEvents = 'none';
            }
        }
        
        hideProfile() {
            this.profileContainer.style.display = 'none';
            this.profileContainer.style.opacity = '0';
            this.profileContainer.style.pointerEvents = 'none';
            document.body.style.overflow = '';
        }
        
        showNotification(title, message, type = 'info') {
            const notification = document.createElement('div');
            notification.className = `notification ${type}`;
            notification.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                padding: 15px 25px;
                background: ${type === 'error' ? '#f44336' : type === 'success' ? '#4CAF50' : '#2196F3'};
                color: white;
                border-radius: 5px;
                z-index: 1000;
                animation: slideIn 0.3s ease-out;
            `;
            
            notification.innerHTML = `
                <div style="font-weight: bold;">${title}</div>
                <div style="font-size: 0.9em; opacity: 0.9;">${message}</div>
            `;
            
            document.body.appendChild(notification);
            
            // Remove after 3 seconds
            setTimeout(() => {
                notification.style.animation = 'slideOut 0.3s ease-in';
                setTimeout(() => notification.remove(), 300);
            }, 3000);
        }
        
        showMoreActionsMenu(event) {
            // Implementation would show a context menu with more actions
            console.log('Show more actions menu at:', event.clientX, event.clientY);
        }
        
        showEditProfile() {
            // Implementation would show an edit profile modal
            console.log('Show edit profile for:', this.currentProfileId);
        }
        
        showFollowersList() {
            // Implementation would show a modal with full followers list
            console.log('Show followers list for:', this.currentProfileId);
        }
        
        showFollowingList() {
            // Implementation would show a modal with full following list
            console.log('Show following list for:', this.currentProfileId);
        }
    }

    // Public API
    const ProfileViewAPI = {
        initialize: function(supabaseClient, currentUserId) {
            try {
                if (!supabaseClient || !currentUserId) {
                    throw new Error('Missing required parameters: supabaseClient and currentUserId');
                }
                
                if (!profileViewInstance) {
                    profileViewInstance = new ProfileView(supabaseClient, currentUserId);
                }
                debug('ProfileView initialized successfully', 'success');
                return profileViewInstance;
            } catch (error) {
                debug(`ProfileView initialization failed: ${error.message}`, 'error');
                return null;
            }
        },
        getInstance: function() {
            return profileViewInstance;
        },
        clearCache: function() {
            profileCache.clear();
            followStatusCache.clear();
            statsCache.clear();
            debug('Cache cleared', 'info');
        }
    };

    // Expose the API to window
    window.ProfileView = ProfileViewAPI;

    // Initialize ProfileView
    if (window.ProfileView) {
        window.ProfileView.initialize(window.supabaseClient, window.currentUserId);
    } else {
        console.error('ProfileView module not loaded');
    }
})();