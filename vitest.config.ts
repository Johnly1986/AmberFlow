import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 浏览器型文件的 beforeAll/afterAll 在 Windows 实测会超默认 10s（多个 chromium 并发 +
    // 杀软实时扫描把 browser.close() 拖过预算）；启动/收尾都是清理而不是判断，放宽预算。
    hookTimeout: 120_000,
    // 几十个测试文件各自起 chromium 时，默认并发（CPU 核数 −1）在弱机上会让页面饿死：
    // 实测满并发下同一批用例随机 BLOCKED / 5s 超时，限到 4 后单跑全绿的三条也全绿。
    // 这不是遮失败——断言一个字没动，只是把"机器的并发预算"变成配置而不是运气。
    maxWorkers: 4,
    minWorkers: 1,
    // `integrations/dsh-bridge` is a self-contained package (its own config, its own DSH-side
    // dependencies). Without this line its `tests/*.spec.ts` join this suite's run and break it —
    // measured: a probe spec under a nested directory was collected by the default include.
    exclude: [...configDefaults.exclude, 'integrations/**'],
  },
})
