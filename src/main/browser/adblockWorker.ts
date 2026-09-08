// 필터 목록 파싱은 CPU 를 많이 쓰므로 worker thread 에서 수행하고, 직렬화된 엔진만 메인으로 돌려준다.
import { parentPort, workerData } from 'node:worker_threads'
import { FiltersEngine } from '@ghostery/adblocker'

interface Input {
  texts: string[]
  resources: string | null
  config: Record<string, boolean>
}

const { texts, resources, config } = workerData as Input

try {
  const engine = FiltersEngine.parse(texts.join('\n'), config)
  if (resources) {
    try {
      engine.updateResources(resources, String(resources.length))
    } catch {
      /* 리소스는 선택 사항 */
    }
  }
  const buffer = engine.serialize()
  parentPort?.postMessage({ ok: true, buffer })
} catch (e) {
  parentPort?.postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) })
}
