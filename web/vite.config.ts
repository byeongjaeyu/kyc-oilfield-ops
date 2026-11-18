import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages: https://byeongjaeyu.github.io/manddang/
export default defineConfig({
  base: '/manddang/',
  plugins: [react()],
  // 글꼴 조각을 CSS 에 base64 로 넣지 않고 파일로 (CSS 가 수백 KB 로 불어나는 것 방지)
  build: { assetsInlineLimit: 0 },
});
