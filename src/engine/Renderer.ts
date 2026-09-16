import * as THREE from 'three';

export type TimeOfDay = 'day' | 'sunset' | 'night';

export class EngineRenderer {
  public scene: THREE.Scene;
  public camera: THREE.PerspectiveCamera;
  public renderer: THREE.WebGLRenderer;
  public container: HTMLElement;

  public dirLight: THREE.DirectionalLight;
  public ambientLight: THREE.AmbientLight;
  public hemiLight: THREE.HemisphereLight;
  public gridHelper: THREE.GridHelper;
  public groundMesh: THREE.Mesh;

  private currentTimeOfDay: TimeOfDay = 'day';

  constructor(containerId: string) {
    const container = document.getElementById(containerId);
    if (!container) throw new Error(`Container #${containerId} not found`);
    this.container = container;

    // 1. Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xd6e6f2); // Day sky blue
    this.scene.fog = new THREE.FogExp2(0xd6e6f2, 0.006);

    // 2. Camera
    const aspect = window.innerWidth / window.innerHeight;
    this.camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
    this.camera.position.set(35, 40, 35);
    this.camera.lookAt(0, 0, 0);

    // 3. WebGLRenderer with soft shadows
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.container.appendChild(this.renderer.domElement);

    // 4. Ground plane
    const groundGeo = new THREE.PlaneGeometry(180, 180);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x86b96e, // Natural rich grass
      roughness: 0.85,
      metalness: 0.05
    });
    this.groundMesh = new THREE.Mesh(groundGeo, groundMat);
    this.groundMesh.rotation.x = -Math.PI / 2;
    this.groundMesh.position.y = -0.01;
    this.groundMesh.receiveShadow = true;
    this.scene.add(this.groundMesh);

    // 5. Grid helper (soft modern grid)
    this.gridHelper = new THREE.GridHelper(96, 48, 0x0284c7, 0x94a3b8);
    this.gridHelper.position.y = 0.01;
    (this.gridHelper.material as THREE.Material).opacity = 0.28;
    (this.gridHelper.material as THREE.Material).transparent = true;
    this.scene.add(this.gridHelper);

    // 6. Lighting
    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.65);
    this.scene.add(this.ambientLight);

    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4);
    this.hemiLight.position.set(0, 50, 0);
    this.scene.add(this.hemiLight);

    this.dirLight = new THREE.DirectionalLight(0xfffaed, 1.25);
    this.dirLight.position.set(50, 75, 40);
    this.dirLight.castShadow = true;
    this.dirLight.shadow.mapSize.width = 2048;
    this.dirLight.shadow.mapSize.height = 2048;
    this.dirLight.shadow.camera.near = 10;
    this.dirLight.shadow.camera.far = 200;
    const d = 50;
    this.dirLight.shadow.camera.left = -d;
    this.dirLight.shadow.camera.right = d;
    this.dirLight.shadow.camera.top = d;
    this.dirLight.shadow.camera.bottom = -d;
    this.dirLight.shadow.bias = -0.0005;
    this.scene.add(this.dirLight);

    // Resize handler
    window.addEventListener('resize', this.onResize.bind(this));
  }

  private onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  public setGridVisible(visible: boolean) {
    this.gridHelper.visible = visible;
  }

  public toggleTimeOfDay(): TimeOfDay {
    if (this.currentTimeOfDay === 'day') {
      this.setTimeOfDay('sunset');
    } else if (this.currentTimeOfDay === 'sunset') {
      this.setTimeOfDay('night');
    } else {
      this.setTimeOfDay('day');
    }
    return this.currentTimeOfDay;
  }

  public setTimeOfDay(time: TimeOfDay) {
    this.currentTimeOfDay = time;
    if (time === 'day') {
      this.scene.background = new THREE.Color(0xd6e6f2);
      (this.scene.fog as THREE.FogExp2).color.set(0xd6e6f2);
      this.dirLight.color.set(0xfffaed);
      this.dirLight.intensity = 1.25;
      this.dirLight.position.set(50, 75, 40);
      this.ambientLight.color.set(0xffffff);
      this.ambientLight.intensity = 0.65;
      (this.groundMesh.material as THREE.MeshStandardMaterial).color.set(0x86b96e);
    } else if (time === 'sunset') {
      this.scene.background = new THREE.Color(0xfdba74);
      (this.scene.fog as THREE.FogExp2).color.set(0xfdba74);
      this.dirLight.color.set(0xf97316);
      this.dirLight.intensity = 1.1;
      this.dirLight.position.set(65, 30, 15);
      this.ambientLight.color.set(0xfb923c);
      this.ambientLight.intensity = 0.55;
      (this.groundMesh.material as THREE.MeshStandardMaterial).color.set(0x927042);
    } else {
      // Night
      this.scene.background = new THREE.Color(0x090d16);
      (this.scene.fog as THREE.FogExp2).color.set(0x090d16);
      this.dirLight.color.set(0x93c5fd);
      this.dirLight.intensity = 0.35;
      this.dirLight.position.set(-30, 60, -40);
      this.ambientLight.color.set(0x1e293b);
      this.ambientLight.intensity = 0.45;
      (this.groundMesh.material as THREE.MeshStandardMaterial).color.set(0x1c2833);
    }
  }

  public getTimeOfDay(): TimeOfDay {
    return this.currentTimeOfDay;
  }

  public render() {
    this.renderer.render(this.scene, this.camera);
  }
}
