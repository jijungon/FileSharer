/** 소스맵을 산출물에서 떼어 옆에 둔다.
 *
 * **왜 빌드가 하나**: 맵을 Dockerfile 에서만 지웠더니, 이미지에는 없는데 로컬·CI e2e 가
 * 보는 dist 에는 그대로 남았다. 같은 명령으로 만든 결과가 보는 곳마다 다르면, 새지
 * 않는다는 걸 아무 데서도 확인할 수 없다. 그래서 `npm run build` 가 직접 떼어낸다.
 *
 * **왜 떼어내나**: 맵에는 원본 코드가 통째로 들어 있다. file.rgrg.im 은 누구나 열 수
 * 있는 주소다. 그렇다고 안 만들 수도 없다 — 없으면 Sentry 에 찍히는 스택이
 * `t.a is not a function` 같은 압축된 글자라 읽을 수가 없다.
 *
 * 압축본(.js)도 같이 복사한다. sentry-cli 가 압축본과 맵을 **파일명으로 짝지어** 올린다.
 */
import { cp, mkdir, readdir, rm, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assets = join(root, 'dist', 'assets')
const out = join(root, 'dist-sourcemaps')

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const names = await readdir(assets)
const maps = names.filter((n) => n.endsWith('.map'))

if (maps.length === 0) {
  // 조용히 넘어가면 '맵이 없는 릴리스'가 아무도 모르게 나간다. 압축된 스택만 남는다.
  console.error('소스맵이 하나도 없습니다 — vite.config.ts 의 build.sourcemap 을 확인하세요')
  process.exit(1)
}

for (const map of maps) {
  const minified = map.slice(0, -4) // index-abc.js.map → index-abc.js
  await cp(join(assets, map), join(out, map))
  if (names.includes(minified)) await cp(join(assets, minified), join(out, minified))
  await unlink(join(assets, map)) // **배포되는 쪽에서는 사라진다**
}

console.log(`소스맵 ${maps.length}개를 dist-sourcemaps/ 로 옮겼습니다 (dist 에는 남기지 않음)`)
