/** 유류 장부 공통 */
export type FuelKind = 'gasoline' | 'diesel' | 'premium' | 'kerosene';
export const FUEL_KO: Record<FuelKind, string> = { gasoline: '휘발유', diesel: '경유', premium: '고급휘발유', kerosene: '등유' };
export const FUELS = Object.keys(FUEL_KO) as FuelKind[];
export const todayKst = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
