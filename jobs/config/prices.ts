/** #4 경쟁 주유소 가격 — 설정 */

/** 반경 (m). 오피넷 최대 5,000 */
export const RADIUS_M = 5000;

/** 알림 기준 */
export const ALERT = {
  /** 우리 가격이 반경 평균보다 이만큼(원) 이상 비싸면 알림 */
  aboveAvgWon: 30,
  /** 싼 순위가 전날보다 이만큼 이상 밀리면 알림 */
  rankDrop: 3,
  /** 주변 주유소가 새로 생기거나 사라지면 알림 */
  stationChange: true,
};

/** history.json 에 남길 최대 일수 */
export const HISTORY_DAYS = 400;

/** 오피넷 호출 절약 */
export const CACHE = {
  /**
   * 마지막 수집 후 이 시간 안에는 다시 호출하지 않음 (수동 실행 시 force 로 무시 가능).
   * 4시간마다 돌지만 GitHub 스케줄이 몇십 분씩 밀릴 수 있어 3시간으로 둠
   */
  minIntervalHours: 3,
  /** 하루 호출 상한. 키 한도(300회)보다 여유 있게 */
  dailyBudget: 250,
};
