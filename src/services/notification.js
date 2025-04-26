import { vapidKeys } from '../utils/vapid';

class NotificationService {
  constructor() {
    this.registration = null;
    this.init();
  }

  async init() {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      this.registration = await navigator.serviceWorker.register('/sw.js');
      await this.requestPermission();
      await this.subscribeToPush();
    }
  }

  async requestPermission() {
    return await Notification.requestPermission();
  }

  async subscribeToPush() {
    const subscription = await this.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: this.urlBase64ToUint8Array(vapidKeys.publicKey)
    });
    
    // Store subscription in Supabase
    const { error } = await supabase
      .from('push_subscriptions')
      .upsert({
        user_id: currentUserId,
        subscription: JSON.stringify(subscription)
      });
    
    return !error;
  }

  urlBase64ToUint8Array(base64String) {
    // ... same helper method as before ...
  }

  async showNotification(title, options) {
    if (this.registration) {
      await this.registration.showNotification(title, {
        icon: '/notification-icon.png',
        badge: '/notification-icon.png',
        ...options
      });
    }
  }
}

export const notificationService = new NotificationService();