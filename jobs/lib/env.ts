const get = (key: string, fallback = ''): string => process.env[key]?.trim() || fallback;

export const env = {
  geminiKey: get('GEMINI_API_KEY'),
  geminiModel: get('GEMINI_MODEL', 'gemini-3.8-flash'),
  anthropicKey: get('ANTHROPIC_API_KEY'),
  anthropicModel: get('ANTHROPIC_MODEL', 'claude-sonnet-5-5'),
  naverClientId: get('NAVER_CLIENT_ID'),
  naverClientSecret: get('NAVER_CLIENT_SECRET'),
  telegramToken: get('TELEGRAM_BOT_TOKEN'),
  telegramChatId: get('TELEGRAM_CHAT_ID'),
  opinetKey: get('OPINET_API_KEY'),
  /** 공공데이터포털 인증키 (국토부 실거래가 등) */
  dataGoKrKey: get('DATA_GO_KR_KEY'),
  /** 캐시(최소 수집 간격)를 무시하고 강제로 수집 */
  force: ['1', 'true'].includes(get('FORCE').toLowerCase()),
  dashboardUrl: get('DASHBOARD_URL', 'https://byeongjaeyu.github.io/manddang/'),
  /** 테스트용: 뉴스 수집 대신 이 JSON 파일의 기사 목록을 사용 */
  newsFixture: get('NEWS_FIXTURE'),
  /** 결과 JSON 저장 위치 (기본: data) */
  dataDir: get('DATA_DIR', 'data'),
};
