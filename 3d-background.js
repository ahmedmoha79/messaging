// mobile-3d-background.js - Optimized for phones
class MobileBackground {
  constructor() {
    // Conservative mobile settings
    this.config = {
      particleCount: 400,  // Reduced from 1200
      connectionDistance: 1.8,
      nodeSize: 0.04,
      rotationSpeed: 0.08, // Slower rotation
      colors: {
        primary: 0x00ff88,
        secondary: 0x00ccff,
        background: 0x0a0a0a
      }
    };

    this.init();
  }

  init() {
    // 1. Check WebGL support first
    if (!this.checkWebGL()) {
      console.log('WebGL not supported - background disabled');
      return;
    }

    // 2. Get container carefully
    this.container = document.getElementById('mapContainer');
    if (!this.container) return;

    // 3. Mobile-optimized Three.js setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.config.colors.background);
    
    this.camera = new THREE.PerspectiveCamera(
      70, // Wider angle
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      50   // Smaller far plane
    );
    this.camera.position.z = 3;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // Disabled for mobile
      powerPreference: "low-power",
      precision: "lowp" // Faster rendering
    });
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    this.renderer.domElement.style.position = 'absolute';
    this.renderer.domElement.style.zIndex = '0';
    this.container.prepend(this.renderer.domElement);

    // 4. Simplified particles
    this.createParticles();
    
    // 5. Start animation
    this.animate();
  }

  checkWebGL() {
    try {
      const canvas = document.createElement('canvas');
      return !!(
        window.WebGLRenderingContext &&
        (canvas.getContext('webgl') || canvas.getContext('experimental-webgl'))
      );
    } catch (e) {
      return false;
    }
  }

  createParticles() {
    const geometry = new THREE.BufferGeometry();
    const pos = new Float32Array(this.config.particleCount * 3);
    const colors = new Float32Array(this.config.particleCount * 3);

    // Spherical distribution with fewer calculations
    for (let i = 0; i < this.config.particleCount; i++) {
      const radius = 2 * Math.cbrt(Math.random());
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      
      pos[i*3] = radius * Math.sin(phi) * Math.cos(theta);
      pos[i*3+1] = radius * Math.sin(phi) * Math.sin(theta);
      pos[i*3+2] = radius * Math.cos(phi);

      // Simple color mixing
      const t = Math.random();
      colors[i*3] = t * 0 + (1-t) * 0.5;  // R
      colors[i*3+1] = t * 1 + (1-t) * 0.8; // G
      colors[i*3+2] = t * 0.53 + (1-t) * 0.2; // B
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: this.config.nodeSize,
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      sizeAttenuation: true
    });

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);
  }

  animate() {
    requestAnimationFrame(() => this.animate());
    
    // Minimal rotation only when visible
    if (document.visibilityState === 'visible') {
      this.particles.rotation.y += 0.0005 * this.config.rotationSpeed;
      this.renderer.render(this.scene, this.camera);
    }
  }

  dispose() {
    // Cleanup when tab is hidden
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.renderer) {
        this.renderer.dispose();
      }
    });
  }
}

// Safe initialization
document.addEventListener('DOMContentLoaded', () => {
  // Only load on capable devices
  if (typeof THREE !== 'undefined' && 
      !/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)) {
    setTimeout(() => {
      const bg = new MobileBackground();
      bg.dispose(); // Setup cleanup handler
    }, 1500); // Delay to prioritize main app
  }
});
