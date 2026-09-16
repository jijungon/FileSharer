/// <reference types="vite/client" />

// 빌드 시 vite.config.ts의 define으로 주입되는 배포 버전 문자열(git 태그/SHA).
declare const __APP_VERSION__: string
