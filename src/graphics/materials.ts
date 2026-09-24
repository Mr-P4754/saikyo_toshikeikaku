import * as THREE from 'three';

/**
 * ゲーム全体で共有される3Dマテリアル定義および昼夜切替管理
 */
export class GameMaterials {
  // 軌道・線路マテリアル
  public static readonly ballastMat = new THREE.MeshStandardMaterial({ color: 0x5a554c, roughness: 0.9, metalness: 0.1 });
  public static readonly sleeperMat = new THREE.MeshStandardMaterial({ color: 0x3d271d, roughness: 0.8 });
  public static readonly railMat = new THREE.MeshStandardMaterial({ color: 0xb0bec5, roughness: 0.3, metalness: 0.85 });
  public static readonly concreteMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.7, metalness: 0.1 });
  public static readonly poleMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.5, metalness: 0.4 });

  // 駅マテリアル
  public static readonly platformMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.8 });
  public static readonly yellowLineMat = new THREE.MeshBasicMaterial({ color: 0xfacc15 });
  public static readonly stationRoofMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.4, metalness: 0.2 });

  // 信号機・保安装置マテリアル
  public static readonly signalGreenMat = new THREE.MeshBasicMaterial({ color: 0x22c55e });
  public static readonly signalRedMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
  public static readonly signalHousingMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 });

  // 道路マテリアル
  public static readonly asphaltMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.9 });
  public static readonly roadLineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  public static readonly sidewalkMat = new THREE.MeshStandardMaterial({ color: 0xcfd8dc, roughness: 0.8 });

  // 樹木・自然マテリアル
  public static readonly woodTrunkMat = new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.9 });
  public static readonly foliageMats = [
    new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.7 }),
    new THREE.MeshStandardMaterial({ color: 0x388e3c, roughness: 0.7 }),
    new THREE.MeshStandardMaterial({ color: 0x1b5e20, roughness: 0.7 }),
  ];

  // 建物マテリアル
  public static readonly wallMats = [
    new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: 0xfde047, roughness: 0.7 }),
    new THREE.MeshStandardMaterial({ color: 0xfb923c, roughness: 0.7 }),
    new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.5 }),
    new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.2, metalness: 0.3 })
  ];
  public static readonly roofMats = [
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.6 })
  ];
  public static readonly windowDayMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.2, metalness: 0.8 });
  public static readonly stationLightMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfffaed, emissiveIntensity: 0.0 });
  public static readonly streetLightMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfbbf24, emissiveIntensity: 0.0 });

  /**
   * 昼夜時間帯に応じたマテリアル発光プロパティの更新
   * @param isNight 夜間判定
   * @param nightFactor 0.0 (真昼) 〜 1.0 (深夜) の連続補間係数
   */
  public static updateMaterialsTimeOfDay(isNight: boolean, nightFactor?: number): void {
    const factor = (nightFactor !== undefined) ? Math.max(0, Math.min(1, nightFactor)) : (isNight ? 1.0 : 0.0);
    
    if (factor > 0.05) {
      this.windowDayMat.color.set(0xfef08a);
      this.windowDayMat.emissive.set(0xf59e0b);
      this.windowDayMat.emissiveIntensity = factor * 0.85;

      this.stationLightMat.emissive.set(0xfffaed);
      this.stationLightMat.emissiveIntensity = factor * 1.0;

      this.streetLightMat.emissive.set(0xfbbf24);
      this.streetLightMat.emissiveIntensity = factor * 1.2;
    } else {
      this.windowDayMat.color.set(0x38bdf8);
      this.windowDayMat.emissive.set(0x000000);
      this.windowDayMat.emissiveIntensity = 0;

      this.stationLightMat.emissiveIntensity = 0;
      this.streetLightMat.emissiveIntensity = 0;
    }
  }

  private static isTransparent = false;

  /**
   * 建物・構造物の半透明透過モード（X-Ray）切替
   * ビル裏や山岳背後の線路視認性を高める
   */
  public static setTransparentMode(enabled: boolean): void {
    this.isTransparent = enabled;
    const opacity = enabled ? 0.3 : 1.0;
    const transparent = enabled;

    for (const mat of this.wallMats) {
      mat.transparent = transparent;
      mat.opacity = opacity;
      mat.needsUpdate = true;
    }
    for (const mat of this.roofMats) {
      mat.transparent = transparent;
      mat.opacity = opacity;
      mat.needsUpdate = true;
    }
    this.windowDayMat.transparent = transparent;
    this.windowDayMat.opacity = opacity;
    this.windowDayMat.needsUpdate = true;
  }

  public static isTransparentMode(): boolean {
    return this.isTransparent;
  }

  private static sharedSet: Set<THREE.Material> | null = null;

  /**
   * ゲーム全体で共有されている静的マテリアルかどうかを判定
   */
  public static isShared(mat: THREE.Material): boolean {
    if (!this.sharedSet) {
      this.sharedSet = new Set<THREE.Material>([
        this.ballastMat,
        this.sleeperMat,
        this.railMat,
        this.concreteMat,
        this.poleMat,
        this.platformMat,
        this.yellowLineMat,
        this.stationRoofMat,
        this.signalGreenMat,
        this.signalRedMat,
        this.signalHousingMat,
        this.asphaltMat,
        this.roadLineMat,
        this.sidewalkMat,
        this.woodTrunkMat,
        ...this.foliageMats,
        ...this.wallMats,
        ...this.roofMats,
        this.windowDayMat,
        this.stationLightMat,
        this.streetLightMat
      ]);
    }
    return this.sharedSet.has(mat);
  }
}

/**
 * ① WebGLリソース（ジオメトリ・動的マテリアル・テクスチャ）の再帰的ガベージコレクション
 * 画面から remove されたメッシュを走査し、GPUメモリ（VRAM）から完全に解放する
 */
export function disposeHierarchy(obj: THREE.Object3D | null | undefined): void {
  if (!obj) return;
  obj.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }
      if (mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const mat of mats) {
          // 共有マテリアルや保護フラグ (keepAlive) の付いたマテリアルは解放しない
          if (!GameMaterials.isShared(mat) && !(mat as any).userData?.keepAlive) {
            mat.dispose();
            for (const key of Object.keys(mat)) {
              const val = (mat as any)[key];
              if (val && typeof val === 'object' && val.isTexture) {
                val.dispose();
              }
            }
          }
        }
      }
    }
  });
}
