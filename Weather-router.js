/* 
 * FIXED POSITION WEATHER TRACKER v3.1
 * - Positioned BELOW navigation (85px from top)
 * - White text for visibility
 * - Guaranteed not to overlap any UI
 */

class WeatherTracker {
  constructor() {
    // Configuration (using your API key)
    this.config = {
      apiKey: 'd364f3908c82fce8fe9fc1fb0b8c0f4b',
      lusakaCoordinates: { lat: -15.3875, lng: 28.3228 },
      updateInterval: 300000 // 5 minutes
    };

    // Initialize after DOM loads
    setTimeout(() => this.init(), 100);
  }

  init() {
    // 1. Verify map and header exist
    const header = document.querySelector('.app-header');
    if (!header) {
      console.error('Header not found - retrying');
      setTimeout(() => this.init(), 500);
      return;
    }

    // 2. Calculate safe position (header height + 5px)
    const headerHeight = header.offsetHeight;
    this.safeTopPosition = headerHeight + 5;

    // 3. Setup tracker
    this.injectStyles();
    this.createWidget();
    this.updateWeather();
    setInterval(() => this.updateWeather(), this.config.updateInterval);
  }

  createWidget() {
    // Remove existing widget if present
    const oldWidget = document.getElementById('safe-weather-widget');
    if (oldWidget) oldWidget.remove();

    // Create new widget
    this.widget = document.createElement('div');
    this.widget.id = 'safe-weather-widget';
    document.body.appendChild(this.widget);
  }

  async updateWeather() {
    try {
      const response = await fetch(
        `https://api.openweathermap.org/data/2.5/weather?lat=${this.config.lusakaCoordinates.lat}&lon=${this.config.lusakaCoordinates.lng}&units=metric&appid=${this.config.apiKey}`
      );
      const data = await response.json();
      this.displayWeather(data);
    } catch (error) {
      console.error('Weather update failed:', error);
    }
  }

  displayWeather(data) {
    if (!this.widget) return;
    
    this.widget.innerHTML = `
      <div class="weather-icon">
        <img src="https://openweathermap.org/img/wn/${data.weather[0].icon}.png">
      </div>
      <div class="weather-info">
        <span class="temp">${Math.round(data.main.temp)}°C</span>
        <span class="conditions">${this.capitalize(data.weather[0].description)}</span>
      </div>
    `;
  }

  capitalize(str) {
    return str.split(' ').map(word => 
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');
  }

  injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #safe-weather-widget {
        position: fixed;
        top: ${this.safeTopPosition}px;
        right: 10px;
        background: rgba(255,255,255,0.15);
        backdrop-filter: blur(5px);
        border-radius: 12px;
        padding: 6px 10px;
        display: flex;
        align-items: center;
        gap: 8px;
        z-index: 999; /* BELOW header (1000) */
        border: 1px solid rgba(255,255,255,0.1);
        box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      }
      .weather-icon img {
        width: 22px;
        height: 22px;
        filter: drop-shadow(0 0 2px rgba(0,0,0,0.3));
      }
      .weather-info {
        display: flex;
        flex-direction: column;
        line-height: 1.2;
      }
      .temp {
        color: white;
        font-size: 13px;
        font-weight: bold;
      }
      .conditions {
        color: rgba(255,255,255,0.8);
        font-size: 10px;
        text-transform: capitalize;
      }
    `;
    document.head.appendChild(style);
  }
}

// Start only after full initialization
document.addEventListener('DOMContentLoaded', () => {
  new WeatherTracker();
});
