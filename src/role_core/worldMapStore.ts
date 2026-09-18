import { ref, type Ref } from "vue";
import type { WorldLocation } from "./types/worldLocation";

export type LocationTree = Record<string, Record<string, Record<string, string[]>>>;

export interface WorldMapSerialData {
  locationTree: LocationTree;
}

export function useWorldMapStore() {
  const locationTree = ref<LocationTree>({});

  /**
   * 登记一个地点（四级结构累加进 locationTree）。
   *
   * NPC 名单不再由此处维护——世界地图改为直接查 `npcStore` 按 `currentLocation` 过滤，
   * 单一数据源避免字段与名单不一致。
   */
  function addLocation(loc: WorldLocation): void {
    const { region, country, area, detail } = loc;
    if (!region) return;

    const tree = locationTree.value;
    if (!tree[region]) tree[region] = {};
    if (country) {
      if (!tree[region][country]) tree[region][country] = {};
      if (area) {
        if (!tree[region][country][area]) tree[region][country][area] = [];
        if (detail && !tree[region][country][area].includes(detail)) {
          tree[region][country][area].push(detail);
        }
      }
    }
  }

  function getRegions(): string[] {
    return Object.keys(locationTree.value);
  }

  function getCountries(region: string): string[] {
    return Object.keys(locationTree.value[region] ?? {});
  }

  function getAreas(region: string, country: string): string[] {
    return Object.keys(locationTree.value[region]?.[country] ?? {});
  }

  function getDetails(region: string, country: string, area: string): string[] {
    return locationTree.value[region]?.[country]?.[area] ?? [];
  }

  function serializeWorldMap(): WorldMapSerialData {
    return {
      locationTree: JSON.parse(JSON.stringify(locationTree.value)),
    };
  }

  function restoreWorldMap(data: WorldMapSerialData | null | undefined): void {
    locationTree.value = data?.locationTree ? JSON.parse(JSON.stringify(data.locationTree)) : {};
  }

  function clearWorldMap(): void {
    locationTree.value = {};
  }

  return {
    locationTree,
    addLocation,
    getRegions,
    getCountries,
    getAreas,
    getDetails,
    serializeWorldMap,
    restoreWorldMap,
    clearWorldMap,
  };
}

export const worldMapStore = useWorldMapStore();
