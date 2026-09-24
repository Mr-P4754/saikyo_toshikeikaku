import * as THREE from 'three';
import { GameMaterials } from '../materials';

/**
 * 道路・住宅・商業ビル・樹木等の都市構造物メッシュ生成ビルダー
 */
export class StructureMeshBuilder {
  /**
   * 道路（アスファルト＋白線＋歩道）
   */
  public static createRoad(rotation: number = 0): THREE.Group {
    const group = new THREE.Group();

    const road = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 2.0), GameMaterials.asphaltMat);
    road.position.y = 0.025;
    road.receiveShadow = true;
    group.add(road);

    const lineGeo = new THREE.PlaneGeometry(0.08, 0.6);
    for (let i = -1; i <= 1; i++) {
      const line = new THREE.Mesh(lineGeo, GameMaterials.roadLineMat);
      line.rotation.x = -Math.PI / 2;
      line.position.set(0, 0.052, i * 0.75);
      group.add(line);
    }

    const sideL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 2.0), GameMaterials.sidewalkMat);
    sideL.position.set(-0.9, 0.04, 0);
    group.add(sideL);

    const sideR = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.08, 2.0), GameMaterials.sidewalkMat);
    sideR.position.set(0.9, 0.04, 0);
    group.add(sideR);

    if (rotation === 1) {
      group.rotation.y = Math.PI / 2;
    }
    return group;
  }

  /**
   * 戸建て住宅
   */
  public static createHouse(type: number = 0): THREE.Group {
    const group = new THREE.Group();
    const wallMat = GameMaterials.wallMats[type % (GameMaterials.wallMats.length - 1)];
    const roofMat = GameMaterials.roofMats[type % GameMaterials.roofMats.length];

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
    const win1 = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
    win1.position.set(0.3, 0.6, 0.655);
    group.add(win1);

    const win2 = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
    win2.position.set(-0.3, 0.6, 0.655);
    group.add(win2);

    return group;
  }

  /**
   * 商業ビル・オフィスビル
   */
  public static createCommercialBuilding(floors: number = 4): THREE.Group {
    const group = new THREE.Group();
    const height = Math.min(floors * 0.75, 5.5);

    const tower = new THREE.Mesh(new THREE.BoxGeometry(1.5, height, 1.5), GameMaterials.wallMats[4]);
    tower.position.y = height / 2;
    tower.castShadow = true;
    group.add(tower);

    const winGeo = new THREE.PlaneGeometry(0.22, 0.32);
    for (let f = 0.5; f < height - 0.4; f += 0.7) {
      for (const x of [-0.45, 0, 0.45]) {
        const winF = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
        winF.position.set(x, f, 0.755);
        group.add(winF);

        const winB = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
        winB.position.set(x, f, -0.755);
        winB.rotation.y = Math.PI;
        group.add(winB);
      }
    }

    const ac = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.25, 0.4), GameMaterials.concreteMat);
    ac.position.set(0.3, height + 0.125, 0.3);
    group.add(ac);

    return group;
  }

  /**
   * 樹木・緑地
   */
  public static createTree(): THREE.Group {
    const group = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.12, 0.8, 6), GameMaterials.woodTrunkMat);
    trunk.position.y = 0.4;
    group.add(trunk);

    const foliageMat = GameMaterials.foliageMats[Math.floor(Math.random() * GameMaterials.foliageMats.length)];
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

  /**
   * 工業系建物（工場・倉庫・コンビナート）
   * @param level 発展レベル (1: 小型倉庫/作業所, 2: 中規模製造工場/サイロ, 3: 大型重化学コンビナート)
   */
  public static createIndustrialBuilding(level: number = 1): THREE.Group {
    const group = new THREE.Group();
    const safeLevel = Math.max(1, Math.min(3, level));

    // コンクリート敷地ベース（1.8 × 0.06 × 1.8）
    const baseGeo = new THREE.BoxGeometry(1.8, 0.06, 1.8);
    const base = new THREE.Mesh(baseGeo, GameMaterials.concreteMat);
    base.position.y = 0.03;
    base.receiveShadow = true;
    group.add(base);

    if (safeLevel === 1) {
      // === Lv.1: 小型作業所・配送倉庫 (Warehouse / Workshop) ===
      // メイン倉庫棟（トタン調・切妻屋根）
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 1.2), GameMaterials.wallMats[3]);
      body.position.set(0, 0.35 + 0.06, -0.1);
      body.castShadow = true;
      group.add(body);

      // 屋根（三角屋根）
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.1, 0.45, 4), GameMaterials.roofMats[0]);
      roof.position.set(0, 0.7 + 0.06 + 0.225, -0.1);
      roof.rotation.y = Math.PI / 4;
      roof.castShadow = true;
      group.add(roof);

      // 搬入口シャッター（ダークスチール調）
      const shutter = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), GameMaterials.roofMats[0]);
      shutter.position.set(0, 0.25 + 0.06, 0.505);
      group.add(shutter);

      // 屋外木箱・パレット（資材）
      const pallet = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.2, 0.35), GameMaterials.woodTrunkMat);
      pallet.position.set(0.5, 0.1 + 0.06, 0.5);
      pallet.castShadow = true;
      group.add(pallet);

      // 小型円筒タンク
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.5, 8), GameMaterials.poleMat);
      tank.position.set(-0.55, 0.25 + 0.06, 0.5);
      tank.castShadow = true;
      group.add(tank);

    } else if (safeLevel === 2) {
      // === Lv.2: 中規模製造工場・サイロ付きプラント (Factory / Plant) ===
      // 主棟
      const mainBuilding = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.0, 1.4), GameMaterials.wallMats[3]);
      mainBuilding.position.set(-0.25, 0.5 + 0.06, 0);
      mainBuilding.castShadow = true;
      group.add(mainBuilding);

      // 屋上換気ダクト
      const duct = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.2, 0.6), GameMaterials.concreteMat);
      duct.position.set(-0.25, 1.0 + 0.06 + 0.1, 0);
      group.add(duct);

      // 円柱形サイロ（2基）
      for (const zOffset of [-0.35, 0.35]) {
        const silo = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 1.1, 12), GameMaterials.railMat);
        silo.position.set(0.52, 0.55 + 0.06, zOffset);
        silo.castShadow = true;
        group.add(silo);

        const cap = new THREE.Mesh(new THREE.ConeGeometry(0.25, 0.18, 12), GameMaterials.roofMats[0]);
        cap.position.set(0.52, 1.1 + 0.06 + 0.09, zOffset);
        group.add(cap);
      }

      // 小型煙突（チムニー）
      const chimney = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 1.6, 8), GameMaterials.poleMat);
      chimney.position.set(-0.6, 0.8 + 0.06, -0.5);
      chimney.castShadow = true;
      group.add(chimney);

      // 窓
      const winGeo = new THREE.PlaneGeometry(0.2, 0.2);
      for (const x of [-0.45, -0.05]) {
        const win = new THREE.Mesh(winGeo, GameMaterials.windowDayMat);
        win.position.set(x, 0.6 + 0.06, 0.705);
        group.add(win);
      }

    } else {
      // === Lv.3: 重化学コンビナート・大型プラント (Industrial Complex / Refinery) ===
      // 中央メインプラント棟
      const plant = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.4, 1.2), GameMaterials.wallMats[3]);
      plant.position.set(-0.15, 0.7 + 0.06, -0.15);
      plant.castShadow = true;
      group.add(plant);

      // 大型サイロ（3基トライアングル配置）
      const siloPositions = [
        { x: 0.55, z: 0.45 },
        { x: 0.55, z: -0.2 },
        { x: 0.05, z: 0.55 }
      ];
      for (const sp of siloPositions) {
        const bigSilo = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.4, 12), GameMaterials.railMat);
        bigSilo.position.set(sp.x, 0.7 + 0.06, sp.z);
        bigSilo.castShadow = true;
        group.add(bigSilo);

        const dome = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8, 0, Math.PI * 2, 0, Math.PI / 2), GameMaterials.roofMats[1]);
        dome.position.set(sp.x, 1.4 + 0.06, sp.z);
        group.add(dome);
      }

      // 高い赤白煙突（2.2m）
      const chimneyBase = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.6, 8), GameMaterials.concreteMat);
      chimneyBase.position.set(-0.6, 0.3 + 0.06, 0.55);
      chimneyBase.castShadow = true;
      group.add(chimneyBase);

      // 赤と白の交互セグメント
      for (let s = 0; s < 4; s++) {
        const mat = (s % 2 === 0) ? GameMaterials.roofMats[1] : GameMaterials.wallMats[0];
        const seg = new THREE.Mesh(new THREE.CylinderGeometry(0.09 - s * 0.01, 0.10 - s * 0.01, 0.4, 8), mat);
        seg.position.set(-0.6, 0.6 + 0.06 + s * 0.4 + 0.2, 0.55);
        seg.castShadow = true;
        group.add(seg);
      }

      // 配管パイプライン（水平）
      const pipeGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.9, 6);
      const pipe = new THREE.Mesh(pipeGeo, GameMaterials.poleMat);
      pipe.rotation.z = Math.PI / 2;
      pipe.position.set(0.1, 1.1 + 0.06, -0.15);
      group.add(pipe);

      // 敷地内警告ライン
      const gateLine = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.08), GameMaterials.yellowLineMat);
      gateLine.rotation.x = -Math.PI / 2;
      gateLine.position.set(-0.4, 0.065, 0.8);
      group.add(gateLine);
    }

    return group;
  }
}
