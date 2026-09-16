import * as THREE from 'three';

export interface FollowTarget {
  position: THREE.Vector3;
  direction: THREE.Vector3;
  speed: number;
}

export type CameraMode = 'orbit' | 'cab' | 'chase';

export class CameraController {
  private camera: THREE.PerspectiveCamera;
  private domElement: HTMLElement;

  // Orbit parameters
  public target: THREE.Vector3 = new THREE.Vector3(0, 0, 0);
  public radius: number = 55;
  public theta: number = Math.PI / 4; // Horizontal angle
  public phi: number = Math.PI / 3.2;  // Vertical elevation angle

  private minRadius = 10;
  private maxRadius = 220;
  private minPhi = 0.15;
  private maxPhi = Math.PI / 2 - 0.05;

  // State
  private isDragging = false;
  private isPanning = false;
  private lastMouseX = 0;
  private lastMouseY = 0;

  // ④ 自由視点でのキーボード移動 (WASD / 矢印キー)。ズーム倍率に関わらず一定速度で遠方まで移動できる。
  private keysPressed: Record<string, boolean> = {};
  private readonly keyPanSpeed = 28; // world units / second

  // Camera Mode
  public mode: CameraMode = 'orbit';
  public followTarget: FollowTarget | null = null;

  constructor(camera: THREE.PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;

    this.updateOrbitPosition();
    this.bindEvents();
  }

  private bindEvents() {
    this.domElement.addEventListener('contextmenu', (e) => e.preventDefault());

    this.domElement.addEventListener('mousedown', (e) => {
      if (this.mode !== 'orbit') return;
      if (e.button === 0) {
        this.isDragging = true;
      } else if (e.button === 2 || e.button === 1) {
        this.isPanning = true;
      }
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    });

    window.addEventListener('mousemove', (e) => {
      if (this.mode !== 'orbit') return;
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;

      if (this.isDragging) {
        // Rotate
        this.theta -= dx * 0.006;
        this.phi = Math.max(this.minPhi, Math.min(this.maxPhi, this.phi - dy * 0.006));
        this.updateOrbitPosition();
      } else if (this.isPanning) {
        // Pan (④ ズームインしていても一定以上の速度で移動できるよう下限を設ける)
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();

        const right = new THREE.Vector3();
        right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

        const factor = Math.max(this.radius, 25) * 0.0015;
        this.target.addScaledVector(right, -dx * factor);
        this.target.addScaledVector(forward, dy * factor);
        this.updateOrbitPosition();
      }
    });

    // ④ キーボードによる自由移動 (WASD / 矢印キー)
    window.addEventListener('keydown', (e) => {
      this.keysPressed[e.key.toLowerCase()] = true;
    });
    window.addEventListener('keyup', (e) => {
      this.keysPressed[e.key.toLowerCase()] = false;
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
      this.isPanning = false;
    });

    this.domElement.addEventListener('wheel', (e) => {
      if (this.mode !== 'orbit') return;
      e.preventDefault();
      const zoomSpeed = 0.0015 * this.radius;
      this.radius = Math.max(this.minRadius, Math.min(this.maxRadius, this.radius + e.deltaY * zoomSpeed));
      this.updateOrbitPosition();
    }, { passive: false });

    // Touch support
    let touchStartDist = 0;
    this.domElement.addEventListener('touchstart', (e) => {
      if (this.mode !== 'orbit') return;
      if (e.touches.length === 1) {
        this.isDragging = true;
        this.lastMouseX = e.touches[0].clientX;
        this.lastMouseY = e.touches[0].clientY;
      } else if (e.touches.length === 2) {
        this.isDragging = false;
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        touchStartDist = Math.hypot(dx, dy);
      }
    });

    window.addEventListener('touchmove', (e) => {
      if (this.mode !== 'orbit') return;
      if (e.touches.length === 1 && this.isDragging) {
        const dx = e.touches[0].clientX - this.lastMouseX;
        const dy = e.touches[0].clientY - this.lastMouseY;
        this.lastMouseX = e.touches[0].clientX;
        this.lastMouseY = e.touches[0].clientY;

        this.theta -= dx * 0.008;
        this.phi = Math.max(this.minPhi, Math.min(this.maxPhi, this.phi - dy * 0.008));
        this.updateOrbitPosition();
      } else if (e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        const diff = touchStartDist - dist;
        touchStartDist = dist;

        this.radius = Math.max(this.minRadius, Math.min(this.maxRadius, this.radius + diff * 0.1));
        this.updateOrbitPosition();
      }
    });

    window.addEventListener('touchend', () => {
      this.isDragging = false;
    });
  }

  private updateOrbitPosition() {
    const x = this.target.x + this.radius * Math.sin(this.phi) * Math.sin(this.theta);
    const y = this.target.y + this.radius * Math.cos(this.phi);
    const z = this.target.z + this.radius * Math.sin(this.phi) * Math.cos(this.theta);

    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target);
  }

  public setCabMode(target: FollowTarget) {
    this.mode = 'cab';
    this.followTarget = target;
  }

  public setOrbitMode() {
    this.mode = 'orbit';
    this.followTarget = null;
    this.updateOrbitPosition();
  }

  public update(deltaTime: number = 0.016) {
    if (this.mode === 'orbit') {
      const k = this.keysPressed;
      const moveForward = (k['w'] || k['arrowup'] ? 1 : 0) - (k['s'] || k['arrowdown'] ? 1 : 0);
      const moveRight = (k['d'] || k['arrowright'] ? 1 : 0) - (k['a'] || k['arrowleft'] ? 1 : 0);

      if (moveForward !== 0 || moveRight !== 0) {
        const forward = new THREE.Vector3();
        this.camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();

        const right = new THREE.Vector3();
        right.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

        const dist = this.keyPanSpeed * deltaTime;
        this.target.addScaledVector(forward, moveForward * dist);
        this.target.addScaledVector(right, moveRight * dist);
        this.updateOrbitPosition();
      }
    }

    if (this.mode === 'cab' && this.followTarget) {
      // Driver Cab View
      const pos = this.followTarget.position;
      const dir = this.followTarget.direction.clone().normalize();

      // Camera positioned inside front cabin, slightly elevated
      const eyePos = pos.clone().add(new THREE.Vector3(0, 1.25, 0)).addScaledVector(dir, 1.1);
      this.camera.position.copy(eyePos);

      // Look slightly ahead on track
      const lookTarget = eyePos.clone().addScaledVector(dir, 15);
      lookTarget.y -= 0.3; // subtle downward tilt
      this.camera.lookAt(lookTarget);
    }
  }
}
