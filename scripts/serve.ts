

import { startMemoSyncServer } from "../src/server/server"
import { applyDeepSeekEngineEnvDefaults } from "../src/server/deepseek-engine-env"

const port = Number(process.env.PORT) || 3210
const host = process.env.HOST || "0.0.0.0"
const dataDir = process.env.DATA_DIR || undefined
const password = process.env.MEMOSYNC_PASSWORD || null
const trustProxy = process.env.MEMOSYNC_TRUST_PROXY === "1"


applyDeepSeekEngineEnvDefaults()


const srv = await startMemoSyncServer({ port, host, dataDir, password, trustProxy, openBrowser: false, strictPort: true })
console.log(`[memosync] serving on http://${host}:${srv.port}`)

const shutdown = async () => {
  try {
    await srv.stop()
  } finally {
    process.exit(0)
  }
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
