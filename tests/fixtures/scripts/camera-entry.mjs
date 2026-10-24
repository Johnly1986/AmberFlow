/**
 * L1 夹具：camera-entry 的**脚本版**（与 apps/camera-entry/pack.json 逐字段等价）。
 *
 * 读法（三段骨架）：
 *   ① 数据槽：`slots` 在各步里（每行一条规划数据；模型不发明值）
 *   ② 决策判断：每步的 `done` = 表单自己的成功/拒绝证据；`invariants` = 结束状态断言
 *   ③ 决策执行：4 步，每步用有序 target_hints（点入口 → 填下拉 → 提交）
 *
 * 这是"脚本能表达同一个应用"的证据，不是新应用——等价性由 app-script-equivalence.test.ts 钉。
 */
export const meta = (kit) => ({
  id: "camera-entry",
  label: "Excel 类型列路由两套设备录入表单（3 行录入成功 + 1 行被表单拒绝）",
  goal: "按 Excel 规划表把每台设备录入对应的表单页；识别出的类型用规则选页，空类型按行内证据显式选页；坏序列号由表单自己拒绝并如实报出来",
  model: "english",
  maxSubgoals: 4,
  hosts: [],
  slots: {},
  sources: [],
  invariants: [
    {
      id: "end-on-the-rejected-form",
      desc: "结束时停在固定焦距表单页，页面上是表单自己的拒绝文案，且输入框里还是我们填的那个值",
      signal: kit.judge.all(
        kit.judge.url("camera_a.html"),
        kit.judge.text("[data-test='a-error']", "序列号格式错误"),
        kit.judge.value("[data-test='a-serial']", "CAM-12"),
      ),
    },
    {
      id: "rejection-not-reported-as-success",
      desc: "被拒绝的那一行没有谎报成功（页面回显的 ok-serial 不是 CAM-12）",
      signal: kit.judge.not(kit.judge.text("[data-test=ok-serial]", "CAM-12")),
    },
    {
      id: "end-state-is-the-fixed-form",
      desc: "结束状态确实是固定焦距表单（序列号输入框在，PTZ 的 S/N 框不在）",
      signal: kit.judge.all(
        kit.judge.exists("[data-test=a-serial]"),
        kit.judge.not(kit.judge.exists("[data-test=b-sn]")),
      ),
    },
  ],
});

const steps = (kit) => [
  kit.step("按规划表录入 CAM-1001（枪机）：进入固定焦距表单，填入该行字段并提交", {
    url: "testpages/portal.html",
    act: kit.hints("[data-test='entry-fixed']", "[data-test='a-resolution']", "[data-test='a-submit']"),
    slots: {
      "a-serial": "CAM-1001", "a-model": "DS-2CD1143", "a-resolution": "4MP",
      "a-focal": "4", "a-ip": "10.0.0.101", "a-location": "东门入口",
    },
    done: kit.judge.all(
      kit.judge.url("entry_success.html"),
      kit.judge.text("[data-test=ok-serial]", "CAM-1001"),
      kit.judge.text("[data-test=ok-form]", "A"),
    ),
  }),
  kit.step("按规划表录入 PTZ-2001（球机）：进入 PTZ 表单，填入该行字段并提交", {
    url: "testpages/portal.html",
    act: kit.hints("[data-test='entry-ptz']", "[data-test='b-zoom']", "[data-test='b-submit']"),
    slots: {
      "b-sn": "PTZ-2001", "b-model": "SD49425", "b-zoom": "20x",
      "b-presets": "8", "b-ip": "10.0.0.102", "b-location": "中庭广场",
    },
    done: kit.judge.all(
      kit.judge.url("entry_success.html"),
      kit.judge.text("[data-test=ok-serial]", "PTZ-2001"),
      kit.judge.text("[data-test=ok-form]", "B"),
    ),
  }),
  kit.step("按规划表录入 PTZ-2002（类型列空）：行内证据是 PTZ 序列号 + 变倍/预置位，显式进入 PTZ 表单并提交", {
    url: "testpages/portal.html",
    act: kit.hints("[data-test='entry-ptz']", "[data-test='b-zoom']", "[data-test='b-submit']"),
    slots: {
      "b-sn": "PTZ-2002", "b-model": "SD6C82", "b-zoom": "32x",
      "b-presets": "16", "b-ip": "10.0.0.103", "b-location": "停车场北",
    },
    done: kit.judge.all(
      kit.judge.url("entry_success.html"),
      kit.judge.text("[data-test=ok-serial]", "PTZ-2002"),
      kit.judge.text("[data-test=ok-form]", "B"),
    ),
  }),
  kit.step("按规划表录入 CAM-12（枪机）：进入固定焦距表单并提交，序列号不合规由表单自己拒绝", {
    url: "testpages/portal.html",
    act: kit.hints("[data-test='entry-fixed']", "[data-test='a-resolution']", "[data-test='a-submit']"),
    slots: {
      "a-serial": "CAM-12", "a-model": "DS-2CD1021", "a-resolution": "1080P",
      "a-focal": "2.8", "a-ip": "10.0.0.104", "a-location": "西门",
    },
    done: kit.judge.all(
      kit.judge.url("camera_a.html"),
      kit.judge.text("[data-test='a-error']", "序列号格式错误"),
      kit.judge.value("[data-test='a-serial']", "CAM-12"),
    ),
  }),
];

export const app = (kit) => ({ data: {}, exec: steps(kit) });
