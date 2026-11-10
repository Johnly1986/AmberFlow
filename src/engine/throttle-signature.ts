/**
 * task-24/6a：限速判据阈值的**单一出处**（架构评审 6a——阈值常量此前写了两份：
 * executor step 侧与 ctx arrive 侧各一份，标定时会漂移）。
 *
 * 三个常量（probe3 现场标定，语义见 F50/F52 与 docs §10 限速判读段）：
 *   - POOL_HIGH_MIN：会话池高峰下限——低于此 = 正常小页面（本来元素就少），不判限速；
 *   - BODY_FLOOR：正文塌缩判据的正文下限（chars）——短页正文波动没有判读意义；
 *   - COLLAPSE_RATIO：骤降比例分母（当前值 ≤ 基线/RATIO 才算塌缩）。
 *
 * 6b 标定（多站点样本，矩阵/真跑数据齐后）改**这里**的值即可同时改两个面；
 * F50/F52 文案中的数字暂不随动（6b 落地时一并更新）。纯常量模块：零 import、零行为。
 */
export const THROTTLE_POOL_HIGH_MIN = 20;
export const THROTTLE_BODY_FLOOR = 2000;
export const THROTTLE_COLLAPSE_RATIO = 4;
