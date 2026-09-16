import * as THREE from 'three';
import { VehicleModelInfo } from '../simulation/VehicleCatalog';

export class ModelFactory {
  // Shared materials
  private static ballastMat = new THREE.MeshStandardMaterial({ color: 0x5a554c, roughness: 0.9, metalness: 0.1 });
  private static sleeperMat = new THREE.MeshStandardMaterial({ color: 0x3d271d, roughness: 0.8 });
  private static railMat = new THREE.MeshStandardMaterial({ color: 0xb0bec5, roughness: 0.3, metalness: 0.85 });
  private static concreteMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.7, metalness: 0.1 });
  private static poleMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.5, metalness: 0.4 });

  // Station materials
  private static platformMat = new THREE.MeshStandardMaterial({ color: 0x64748b, roughness: 0.8 });
  private static yellowLineMat = new THREE.MeshBasicMaterial({ color: 0xfacc15 });
  private static stationRoofMat = new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.4, metalness: 0.2 });

  // Road materials
  private static asphaltMat = new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.9 });
  private static roadLineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private static sidewalkMat = new THREE.MeshStandardMaterial({ color: 0xcfd8dc, roughness: 0.8 });

  // Tree materials
  private static woodTrunkMat = new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.9 });
  private static foliageMats = [
    new THREE.MeshStandardMaterial({ color: 0x2e7d32, roughness: 0.7 }),
    new THREE.MeshStandardMaterial({ color: 0x388e3c, roughness: 0.7 }),
    new THREE.MeshStandardMaterial({ color: 0x1b5e20, roughness: 0.7 }),
  ];

  // Building materials
  private static wallMats = [
    new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: 0xfde047, roughness: 0.7 }),
    new THREE.MeshStandardMaterial({ color: 0xfb923c, roughness: 0.7 }),
    new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.5 }),
    new THREE.MeshStandardMaterial({ color: 0x0284c7, roughness: 0.2, metalness: 0.3 })
  ];
  private static roofMats = [
    new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.6 }),
    new THREE.MeshStandardMaterial({ color: 0x1d4ed8, roughness: 0.6 })
  ];
  private static windowDayMat = new THREE.MeshStandardMaterial({ color: 0x38bdf8, roughness: 0.2, metalness: 0.8 });

  public static updateMaterialsTimeOfDay(isNight: boolean) {
    if (isNight) {
      this.windowDayMat.color.set(0xfef08a);
      this.windowDayMat.emissive.set(0xf59e0b);
      this.windowDayMat.emissiveIntensity = 0.8;
    } else {
      this.windowDayMat.color.set(0x38bdf8);
      this.windowDayMat.emissive.set(0x000000);
      this.windowDayMat.emissiveIntensity = 0;
    }
  }

  /**
   * Create Ground Straight Track
   */
  public static createGroundTrack(rotation: number = 0, hasPole: boolean = false): THREE.Group {
    const group = new THREE.Group();

    const ballastGeo = new THREE.BoxGeometry(1.6, 0.16, 2.0);
    const ballast = new THREE.Mesh(ballastGeo, this.ballastMat);
    ballast.position.y = 0.08;
    ballast.receiveShadow = true;
    group.add(ballast);

    const sleeperGeo = new THREE.BoxGeometry(1.4, 0.08, 0.16);
    for (let i = 0; i < 5; i++) {
      const sleeper = new THREE.Mesh(sleeperGeo, this.sleeperMat);
      sleeper.position.set(0, 0.18, (i / 4 - 0.5) * 1.5);
      sleeper.castShadow = true;
      group.add(sleeper);
    }

    const railGeo = new THREE.BoxGeometry(0.06, 0.1, 2.0);
    const railL = new THREE.Mesh(railGeo, this.railMat);
    railL.position.set(-0.45, 0.24, 0);
    railL.castShadow = true;
    group.add(railL);

    const railR = new THREE.Mesh(railGeo, this.railMat);
    railR.position.set(0.45, 0.24, 0);
    railR.castShadow = true;
    group.add(railR);

    if (hasPole) {
      group.add(this.createCatenaryPole());
    }

    if (rotation === 1) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  private static readonly DIR_IDX_VEC: { x: number; z: number }[] = [
    { x: 0, z: -1 }, // 0: N
    { x: 1, z: 0 },  // 1: E
    { x: 0, z: 1 },  // 2: S
    { x: -1, z: 0 }  // 3: W
  ];
  private static readonly CURVE_DIR_INDICES: Record<'N_E' | 'E_S' | 'S_W' | 'W_N', [number, number]> = {
    N_E: [0, 1], E_S: [1, 2], S_W: [2, 3], W_N: [3, 0]
  };

  /**
   * 方向インデックス idxA・idxB(0=北,1=東,2=南,3=西)を、タイル角を中心とする
   * 半径1の円弧で滑らかに結ぶ枕木・レールを group に追加する（曲線レール・分岐器で共用）。
   * レール間隔・端部の位置は直線レールと厳密に一致するため接続部が違和感なく繋がる。
   */
  private static addCurveRails(group: THREE.Group, idxA: number, idxB: number, baseHeight: number, sleeperCount: number = 3) {
    // 円弧の中心 = idxA・idxB それぞれの方向ベクトルの和（タイル角を指す）
    const vA = this.DIR_IDX_VEC[idxA];
    const vB = this.DIR_IDX_VEC[idxB];
    const cx = vA.x + vB.x;
    const cz = vA.z + vB.z;

    const edgeAngle = (v: { x: number; z: number }) => Math.atan2(v.z - cz, v.x - cx);
    let a1 = edgeAngle(vA);
    let a2 = edgeAngle(vB);
    let diff = a2 - a1;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    a2 = a1 + diff;

    for (let i = 0; i < sleeperCount; i++) {
      const theta = a1 + ((i + 0.5) / sleeperCount) * (a2 - a1);
      const sleeper = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.08, 0.18), this.sleeperMat);
      sleeper.position.set(cx + Math.cos(theta) * 1.0, baseHeight + 0.18, cz + Math.sin(theta) * 1.0);
      sleeper.rotation.y = -theta;
      group.add(sleeper);
    }

    const railPtsInner: THREE.Vector3[] = [];
    const railPtsOuter: THREE.Vector3[] = [];
    const steps = 8;
    const rInner = 1 - 0.45;
    const rOuter = 1 + 0.45;
    for (let s = 0; s <= steps; s++) {
      const t = a1 + (s / steps) * (a2 - a1);
      railPtsInner.push(new THREE.Vector3(cx + Math.cos(t) * rInner, baseHeight + 0.24, cz + Math.sin(t) * rInner));
      railPtsOuter.push(new THREE.Vector3(cx + Math.cos(t) * rOuter, baseHeight + 0.24, cz + Math.sin(t) * rOuter));
    }

    const tubeGeoIn = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPtsInner), 10, 0.035, 6, false);
    const tubeGeoOut = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPtsOuter), 10, 0.035, 6, false);
    group.add(new THREE.Mesh(tubeGeoIn, this.railMat));
    group.add(new THREE.Mesh(tubeGeoOut, this.railMat));
  }

  /**
   * ② ③ 曲線レール (1マス・斜め接続のカーブ)
   * curveDir が示す2方向（例: N_E なら北と東）のタイル端の中点を1マス内で滑らかに結ぶ。
   */
  public static createCurveTrackSegment(curveDir: 'N_E' | 'E_S' | 'S_W' | 'W_N', isElevated: boolean = false): THREE.Group {
    const group = new THREE.Group();
    const baseHeight = isElevated ? 3.0 : 0;

    if (isElevated) {
      const pierGeo = new THREE.BoxGeometry(0.7, baseHeight, 0.7);
      const pier = new THREE.Mesh(pierGeo, this.concreteMat);
      pier.position.y = baseHeight / 2;
      group.add(pier);

      const deckGeo = new THREE.BoxGeometry(2.0, 0.35, 2.0);
      const deck = new THREE.Mesh(deckGeo, this.concreteMat);
      deck.position.y = baseHeight + 0.175;
      group.add(deck);
    } else {
      const bedGeo = new THREE.BoxGeometry(1.9, 0.16, 1.9);
      const bed = new THREE.Mesh(bedGeo, this.ballastMat);
      bed.position.y = 0.08;
      group.add(bed);
    }

    const [idxA, idxB] = this.CURVE_DIR_INDICES[curveDir];
    this.addCurveRails(group, idxA, idxB, baseHeight);

    return group;
  }

  /**
   * ⑦ ⑧ 分岐器ハブ（2×2マス分岐器の起点タイル）: 直進レール＋分岐開始のレール＋転轍機・信号灯
   * forward: 通過(直進)方向インデックス(0=北,1=東,2=南,3=西)。分岐はforwardの右手方向(rotateCW)へ伸びる。
   */
  public static createSwitchHub(forward: number = 0, isDiverged: boolean = false, isElevated: boolean = false): THREE.Group {
    const group = new THREE.Group();
    const baseHeight = isElevated ? 3.0 : 0;
    const back = (forward + 2) % 4;
    const right = (forward + 1) % 4;
    const axisRotation = (forward === 1 || forward === 3) ? 1 : 0;

    // Straight through-track base (back <-> forward)
    const baseTrack = isElevated ? this.createElevatedTrack(axisRotation) : this.createGroundTrack(axisRotation, false);
    group.add(baseTrack);

    // Diverging rail lead-in (back -> right), using the same arc math as plain curve tiles
    // for a seamless visual hand-off into the adjoining leg tile.
    this.addCurveRails(group, back, right, baseHeight, 2);

    // Movable Switch Tongue (Point lever & indicator light) — placed toward the diverge side
    const rightVec = this.DIR_IDX_VEC[right];
    const boxGeo = new THREE.BoxGeometry(0.25, 0.3, 0.35);
    const switchBoxMat = new THREE.MeshStandardMaterial({ color: 0xfacc15, metalness: 0.5 });
    const switchBox = new THREE.Mesh(boxGeo, switchBoxMat);
    switchBox.position.set(rightVec.x * 0.75, baseHeight + 0.2, rightVec.z * 0.75);
    group.add(switchBox);

    const lampMat = new THREE.MeshBasicMaterial({ color: isDiverged ? 0xf59e0b : 0x10b981 });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), lampMat);
    lamp.position.set(rightVec.x * 0.75, baseHeight + 0.42, rightVec.z * 0.75);
    group.add(lamp);

    return group;
  }

  /**
   * ① 勾配線路 (4マス1組の直線区間で緩やかに地上⇔高架を接続する)
   * rotation: 0 = 南北軸, 1 = 東西軸。reversed: 上る方向（軸のどちら側が高架か）。
   * part: 0(地上寄りの端)〜3(高架寄りの端)。1マスあたり全体の1/4(0.75)だけ高さが変わる。
   */
  public static createSlopeTrackPart(rotation: number = 0, reversed: boolean = false, part: number = 0): THREE.Group {
    const group = new THREE.Group();
    const totalHeight = 3.0;
    const partRise = totalHeight / 4; // 0.75
    const centerY = (part + 0.5) * partRise;
    // 4マス全体でなだらかに上るため、1マスあたりの勾配角は緩やか
    const pitch = Math.atan2(partRise, 2.0);

    // ③ rotation=1(東西軸)では group.rotation.y=90° により、ローカル+Z軸がワールド+X軸に写像される。
    // そのため、ローカルX軸まわりの傾き(rotation.x)が実際の高低に与える効果は南北軸/東西軸で符号が反転する。
    // 軸ごとに符号を補正しないと、南北方向に設置した際に1マスごとに傾きが逆転して見えるバグになる。
    const axisSign = rotation === 1 ? 1 : -1;
    const localPitch = (reversed ? -axisSign : axisSign) * pitch;

    const bedGeo = new THREE.BoxGeometry(2.0, 0.4, 2.05);
    const bed = new THREE.Mesh(bedGeo, this.concreteMat);
    bed.position.set(0, centerY, 0);
    bed.rotation.x = localPitch;
    group.add(bed);

    // 区間ごとの支柱（地面からその区間の高さまで）
    const pierHeight = Math.max(centerY, 0.15);
    const pierGeo = new THREE.BoxGeometry(0.7, pierHeight, 0.7);
    const pier = new THREE.Mesh(pierGeo, this.concreteMat);
    pier.position.set(0, pierHeight / 2, 0);
    group.add(pier);

    const railGeo = new THREE.BoxGeometry(0.06, 0.08, 2.05);
    const railL = new THREE.Mesh(railGeo, this.railMat);
    railL.position.set(-0.45, centerY + 0.25, 0);
    railL.rotation.x = localPitch;
    group.add(railL);

    const railR = new THREE.Mesh(railGeo, this.railMat);
    railR.position.set(0.45, centerY + 0.25, 0);
    railR.rotation.x = localPitch;
    group.add(railR);

    if (rotation === 1) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  /**
   * Elevated Track
   * showPier: ② 連続する高架区間では4マスごとに1本だけ橋脚を表示する（間のマスはデッキのみ）
   */
  public static createElevatedTrack(rotation: number = 0, showPier: boolean = true): THREE.Group {
    const group = new THREE.Group();
    const height = 3.0;

    if (showPier) {
      const pierGeo = new THREE.BoxGeometry(0.8, height, 0.8);
      const pier = new THREE.Mesh(pierGeo, this.concreteMat);
      pier.position.y = height / 2;
      pier.castShadow = true;
      group.add(pier);
    }

    const deckGeo = new THREE.BoxGeometry(2.0, 0.35, 2.0);
    const deck = new THREE.Mesh(deckGeo, this.concreteMat);
    deck.position.y = height + 0.175;
    deck.receiveShadow = true;
    group.add(deck);

    const wallGeo = new THREE.BoxGeometry(0.12, 0.65, 2.0);
    const wallL = new THREE.Mesh(wallGeo, this.concreteMat);
    wallL.position.set(-0.94, height + 0.45, 0);
    group.add(wallL);

    const wallR = new THREE.Mesh(wallGeo, this.concreteMat);
    wallR.position.set(0.94, height + 0.45, 0);
    group.add(wallR);

    const sleeperGeo = new THREE.BoxGeometry(1.3, 0.06, 0.16);
    for (let i = 0; i < 5; i++) {
      const sleeper = new THREE.Mesh(sleeperGeo, this.sleeperMat);
      sleeper.position.set(0, height + 0.38, (i / 4 - 0.5) * 1.5);
      group.add(sleeper);
    }

    const railGeo = new THREE.BoxGeometry(0.06, 0.08, 2.0);
    const railL = new THREE.Mesh(railGeo, this.railMat);
    railL.position.set(-0.45, height + 0.44, 0);
    group.add(railL);

    const railR = new THREE.Mesh(railGeo, this.railMat);
    railR.position.set(0.45, height + 0.44, 0);
    group.add(railR);

    if (rotation === 1) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  /**
   * ⑧ 複数マス駅ホーム (Station Platform with Part type)
   * part: 'single' (単独), 'start' (端スロープ), 'mid' (中間連続), 'end' (終端スロープ)
   */
  public static createStation(rotation: number = 0, isElevated: boolean = false, part: 'single' | 'start' | 'mid' | 'end' = 'single'): THREE.Group {
    const group = new THREE.Group();
    const baseHeight = isElevated ? 3.0 : 0;

    const track = isElevated ? this.createElevatedTrack(rotation) : this.createGroundTrack(rotation, false);
    group.add(track);

    // Platform Slab
    const pLength = (part === 'start' || part === 'end') ? 1.8 : 2.0;
    const platformGeo = new THREE.BoxGeometry(0.85, 0.45, pLength);
    const platform = new THREE.Mesh(platformGeo, this.platformMat);
    platform.position.set(1.0, baseHeight + 0.225, 0);
    platform.receiveShadow = true;
    group.add(platform);

    // Yellow warning tactile line
    const yellowGeo = new THREE.PlaneGeometry(0.08, pLength - 0.05);
    const yellow = new THREE.Mesh(yellowGeo, this.yellowLineMat);
    yellow.rotation.x = -Math.PI / 2;
    yellow.position.set(0.65, baseHeight + 0.46, 0);
    group.add(yellow);

    // Canopy roof on mid and single
    if (part === 'single' || part === 'mid') {
      const roofPillars = [-0.6, 0.6];
      roofPillars.forEach(z => {
        const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.4, 6), this.poleMat);
        pillar.position.set(1.1, baseHeight + 0.45 + 0.7, z);
        group.add(pillar);
      });

      const canopyGeo = new THREE.BoxGeometry(0.95, 0.08, 2.0);
      const canopy = new THREE.Mesh(canopyGeo, this.stationRoofMat);
      canopy.position.set(1.0, baseHeight + 0.45 + 1.4, 0);
      canopy.castShadow = true;
      group.add(canopy);

      // Station Signboard
      const signGeo = new THREE.BoxGeometry(0.05, 0.25, 0.65);
      const sign = new THREE.Mesh(signGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
      sign.position.set(0.95, baseHeight + 1.25, 0);
      group.add(sign);
    }

    if (rotation === 1) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  private static createCatenaryPole(): THREE.Group {
    const poleGroup = new THREE.Group();
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 2.4, 6), this.poleMat);
    mast.position.set(-1.0, 1.2, 0);
    poleGroup.add(mast);

    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.04, 0.04), this.poleMat);
    arm.position.set(-0.4, 2.3, 0);
    poleGroup.add(arm);
    return poleGroup;
  }

  /**
   * Road, House, Commercial, Tree
   */
  public static createRoad(rotation: number = 0): THREE.Group {
    const group = new THREE.Group();
    const road = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 2.0), this.asphaltMat);
    road.position.y = 0.025;
    road.receiveShadow = true;
    group.add(road);

    const lineGeo = new THREE.PlaneGeometry(0.08, 0.6);
    for (let i = -1; i <= 1; i++) {
      const line = new THREE.Mesh(lineGeo, this.roadLineMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(0, 0.052, i * 0.75);
      group.add(line);
    }

    const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 2.0), this.sidewalkMat);
    sideL.position.set(-0.9, 0.04, 0);
    group.add(sideL);

    const sideR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 2.0), this.sidewalkMat);
    sideR.position.set(0.9, 0.04, 0);
    group.add(sideR);

    if (rotation === 1) group.rotation.y = Math.PI / 2;
    return group;
  }

  public static createHouse(type: number = 0): THREE.Group {
    const group = new THREE.Group();
    const wallMat = this.wallMats[type % (this.wallMats.length - 1)];
    const roofMat = this.roofMats[type % this.roofMats.length];

    const body = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.1, 1.3), wallMat);
    body.position.y = 0.55;
    body.castShadow = true;
    group.add(body);

    const roof = new THREE.Mesh(new THREE.ConeGeometry(1.1, 0.65, 4), roofMat);
    roof.position.y = 1.425;
    roof.rotation.y = Math.PI / 4;
    roof.castShadow = true;
    group.add(roof);

    const winGeo = new THREE.PlaneGeometry(0.25, 0.3);
    const win1 = new THREE.Mesh(winGeo, this.windowDayMat);
    win1.position.set(0.3, 0.6, 0.655);
    group.add(win1);

    const win2 = new THREE.Mesh(winGeo, this.windowDayMat);
    win2.position.set(-0.3, 0.6, 0.655);
    group.add(win2);
    return group;
  }

  public static createCommercialBuilding(floors: number = 4): THREE.Group {
    const group = new THREE.Group();
    const height = Math.min(floors * 0.75, 5.5);

    const tower = new THREE.Mesh(new THREE.BoxGeometry(1.5, height, 1.5), this.wallMats[4]);
    tower.position.y = height / 2;
    tower.castShadow = true;
    group.add(tower);

    const winGeo = new THREE.PlaneGeometry(0.22, 0.32);
    for (let f = 0.5; f < height - 0.4; f += 0.7) {
      for (let x of [-0.45, 0, 0.45]) {
        const winF = new THREE.Mesh(winGeo, this.windowDayMat);
        winF.position.set(x, f, 0.755);
        group.add(winF);

        const winB = new THREE.Mesh(winGeo, this.windowDayMat);
        winB.position.set(x, f, -0.755);
        winB.rotation.y = Math.PI;
        group.add(winB);
      }
    }

    const ac = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.25, 0.4), this.concreteMat);
    ac.position.set(0.3, height + 0.125, 0.3);
    group.add(ac);
    return group;
  }

  public static createTree(): THREE.Group {
    const group = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.8, 6), this.woodTrunkMat);
    trunk.position.y = 0.4;
    group.add(trunk);

    const foliageMat = this.foliageMats[Math.floor(Math.random() * this.foliageMats.length)];
    const leaves1 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.65, 1), foliageMat);
    leaves1.position.set(0, 1.0, 0);
    leaves1.castShadow = true;
    group.add(leaves1);

    const leaves2 = new THREE.Mesh(new THREE.DodecahedronGeometry(0.48, 1), foliageMat);
    leaves2.position.set(0.2, 1.4, -0.1);
    leaves2.castShadow = true;
    group.add(leaves2);
    return group;
  }

  // ④ 車両間隔。TrainManager が各車両を個別にカーブ追従させる際の遅延距離計算にも使用する。
  public static readonly CAR_SPACING = 1.95;

  /**
   * ⑤ & ⑦ 車両編成の動的生成（車種カタログ＋指定両数 1〜4両）
   */
  public static createTrainFormation(modelInfo: VehicleModelInfo, carCount: 1 | 2 | 3 | 4 = 3): { group: THREE.Group; cars: THREE.Group[] } {
    const formationGroup = new THREE.Group();
    const cars: THREE.Group[] = [];

    for (let i = 0; i < carCount; i++) {
      const isFront = (i === 0);
      const isRear = (i === carCount - 1);
      const hasDoubleCab = (carCount === 1); // 単行気動車

      const car = this.createStyledTrainCar(modelInfo, isFront, isRear, hasDoubleCab);

      // ④ グループ原点(Z=0)＝進行方向の先頭車の初期位置とし、後続車はローカル-Z（後方）へ順に並べる
      // （初期表示のみのフォールバック。実際の走行中は TrainManager が経路履歴を辿って各車両を
      // 個別に配置・回転させ、カーブでは1両ずつ順に曲がるようにする）。
      const offsetZ = -i * this.CAR_SPACING;
      car.position.z = offsetZ;

      formationGroup.add(car);
      cars.push(car);
    }

    return { group: formationGroup, cars };
  }

  /**
   * 車種情報に応じた単両カーの生成
   */
  private static createStyledTrainCar(
    modelInfo: VehicleModelInfo,
    isFront: boolean,
    isRear: boolean,
    hasDoubleCab: boolean
  ): THREE.Group {
    const car = new THREE.Group();
    const length = 1.85;
    const width = 0.72;
    const height = 0.78;

    // Body Material with custom body color
    const bodyMat = new THREE.MeshStandardMaterial({
      color: modelInfo.bodyColor,
      metalness: modelInfo.bodyColor === 0xd1d5db ? 0.8 : 0.2,
      roughness: 0.35
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(width, height, length), bodyMat);
    body.position.y = height / 2 + 0.24;
    body.castShadow = true;
    car.add(body);

    // Stripe
    const stripeMat = new THREE.MeshStandardMaterial({
      color: modelInfo.stripeColor,
      roughness: 0.3
    });
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(width + 0.01, 0.12, length + 0.005), stripeMat);
    stripe.position.y = height / 2 + 0.15;
    car.add(stripe);

    // Roof
    const roofMat = new THREE.MeshStandardMaterial({
      color: modelInfo.roofColor,
      roughness: 0.6
    });
    const roof = new THREE.Mesh(new THREE.BoxGeometry(width - 0.04, 0.08, length), roofMat);
    roof.position.y = height + 0.26;
    car.add(roof);

    // Cab Nose & Lights (Front / Rear)
    if (isFront || isRear || hasDoubleCab) {
      const zDir = isFront ? 1 : -1;
      const maskMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.3 });

      // Nose geometry based on cabShape
      let cabMesh: THREE.Mesh;
      if (modelInfo.cabShape === 'streamline') {
        // Aerodynamic bullet nose
        const coneGeo = new THREE.ConeGeometry(0.36, 0.45, 8);
        coneGeo.rotateX(Math.PI / 2 * zDir);
        cabMesh = new THREE.Mesh(coneGeo, maskMat);
        cabMesh.position.set(0, height / 2 + 0.24, (length / 2 + 0.18) * zDir);
      } else {
        cabMesh = new THREE.Mesh(new THREE.BoxGeometry(width + 0.005, height * 0.9, 0.08), maskMat);
        cabMesh.position.set(0, height / 2 + 0.24, (length / 2 + 0.03) * zDir);
      }
      car.add(cabMesh);

      // Headlight / Taillight
      const isHead = isFront || (hasDoubleCab && zDir === 1);
      const lightMat = new THREE.MeshBasicMaterial({ color: isHead ? 0xfffae0 : 0xef4444 });
      const lightL = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), lightMat);
      lightL.position.set(-0.22, 0.45, (length / 2 + 0.07) * zDir);
      car.add(lightL);

      const lightR = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), lightMat);
      lightR.position.set(0.22, 0.45, (length / 2 + 0.07) * zDir);
      car.add(lightR);
    }

    // Windows
    const winMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, roughness: 0.1, metalness: 0.9 });
    for (let z of [-0.45, 0.45]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(width + 0.02, 0.26, 0.38), winMat);
      win.position.set(0, height / 2 + 0.32, z);
      car.add(win);
    }

    // Pantograph (Electric models only, on front car)
    if (modelInfo.category !== 'diesel' && isFront) {
      const panto = this.createPantograph();
      panto.position.set(0, height + 0.32, -0.4);
      car.add(panto);
    }

    // Bogies & Wheels
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.8, roughness: 0.3 });
    for (let bz of [-0.55, 0.55]) {
      const wL = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.06, 12), wheelMat);
      wL.rotation.z = Math.PI / 2;
      wL.position.set(-0.36, 0.12, bz);
      car.add(wL);

      const wR = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.06, 12), wheelMat);
      wR.rotation.z = Math.PI / 2;
      wR.position.set(0.36, 0.12, bz);
      car.add(wR);
    }

    return car;
  }

  private static createPantograph(): THREE.Group {
    const pGroup = new THREE.Group();
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xef4444, metalness: 0.6, roughness: 0.3 });

    const base = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 0.24), frameMat);
    pGroup.add(base);

    const arm1 = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.28), frameMat);
    arm1.rotation.x = Math.PI / 4;
    arm1.position.set(0, 0.1, 0.06);
    pGroup.add(arm1);

    const arm2 = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.28), frameMat);
    arm2.rotation.x = -Math.PI / 4;
    arm2.position.set(0, 0.22, 0.06);
    pGroup.add(arm2);

    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 0.04), frameMat);
    shoe.position.set(0, 0.32, 0);
    pGroup.add(shoe);
    return pGroup;
  }
}
