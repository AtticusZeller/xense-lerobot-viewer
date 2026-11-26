# 补采计划与进度（viewer #4）

这是补采 v2 的离线计划步骤。已读 [viewer #4](https://github.com/AtticusZeller/xense-lerobot-viewer/issues/4)、[#6](https://github.com/AtticusZeller/xense-lerobot-viewer/issues/6)、[#5](https://github.com/AtticusZeller/xense-lerobot-viewer/issues/5) 和 [lerobot-check #2](https://github.com/AtticusZeller/lerobot-check/issues/2)。以 viewer `04c852f`、lerobot-check `16101a3` 为已合并的起点。复用 `suggest.py` 的标定区域/覆盖分箱/稀疏优先与 `masks.py` 的审核模板和投影；原版 suggestions、测试点、CSV、mask bundle 和实时小窗格式仍可独立使用。本期只改两个仓库、各开一个互链的 PR；依赖顺序是 lerobot-check 先合，viewer 后合，本任务不合并。不改 lerobot-xense，不实现并行推进的自动对齐算法，不做实机验证，不触碰 Hub 数据。#2 和 #5 在 v2 第一版一起上线，计划格式文档分别列出两者用到的字段。

### Task: 固定 #5 可直接读写的本地契约

**Change**

- [x] 计划是单个 UTF-8 JSON，`format: "lerobot-collection-plan"`，`version: 1`。顶层 `plan_id` 是稳定 UUID，`generation` 从 1 递增，`next_round_id` 防止旧 ID 被复用。`repo_id`、`revision` 标识基准数据集，`source_episode_count` 是建计划时的 episode 总数；`camera` 是 LeRobot feature key，`image_size` 为 `[width,height]`，`camera_serial` 为字符串或 `null`。相机序列号优先取标定内参已有的结构化 `serial_number`，兼容现有 `RealSense <model> <serial>, …` 设备说明；无法明确识别则留空，仅供离线预览，#5 现场必须拒绝无身份或序列号/原生画幅不符的计划。`calibration_sha256` 哈希实际读取的标定文件原始字节。
- [x] `settings` 保存本代的 `round_count`（要生成的待采轮数）、`objects_per_round`、`seed`、`min_revisit_distance_m` 和 `region_source`。顶层 `mask_bundle_sha256` 指向本代候选的 v1 mask bundle；`rounds` 按执行顺序，每轮带稳定正整数 `id`、自己的 `mask_bundle_sha256`、`targets`、`status`、`episode_index`。每个目标带 v1 bundle 原字段 `kind: "placement"`、`object`、`index`、`pixel`、`arrow_end_pixel`、`outline`、`reason`，外加 `arm`、`x_m`、`y_m`、`z_m`、`yaw_deg`、`yaw_symmetry_deg` 和用于反投影的 `outline_plane_z_m`（没有轮廓时为 `null`）。坐标为原采样语义：机器人该臂 base 下的工具锚点，以米、角度记；像素用标定头图原生坐标。非空轮廓为隐式闭合外环，对称方向按周期比较，`outline: null` 时必有原因。生成器调用同一 v1 bundle 投影函数；按实际 UTF-8 bundle 文件字节取 SHA-256，保存于 `.xense-viewer/plans/bundles/<sha256>.json` 供追溯。导出计划内已有目标，#5 不需要 bundle、标定文件或服务器；再生成时旧轮仍保留自己的 bundle 哈希。
- [x] 文件默认 `.xense-viewer/plans/<org>__<name>@<revision>.json`。`status` 仅 `pending` / `collected` / `skipped`；未采及跳过的 `episode_index` 为 `null`；已采用保存成功后返回/确认的真实零基 `episode_index`，同计划不得重复，不用轮号、文件中的行号或尝试次数推算。v1 以在同一 local repo 上追加录制为前提，#5 核对 repo 和基线 revision，并拒绝比 `source_episode_count` 小的已采编号；新建另一个采集 repo 或换校准/基线不在本次范围。#5 读首个 `pending`，保存后只写该轮 `status` 与 `episode_index`；重录/丢弃不写。终态不可反转，同一完成记录重复提交幂等。若 episode 已保存、状态尚未写入时进程中断，JSON 仍有效；#5 要用明确的本地 episode/轮次关联来补记，无关联则报出待核对，不靠下一个编号自动归因。#4 提供可独立移植的标准库进度读写模块和最小示例。
- [x] 所有写入由 Python 持一份固定、不会被替换或删除的同目录 `<plan>.lock` 的 Linux `flock`；锁内重读校验，写同目录临时文件并同步，原子替换后同步目录。读者只见旧或新完整 JSON。#5 本地采集会话独占同一把锁，避免 reset 到保存期间被重新生成替换；#5 和生成器都不得盲写旧快照。Viewer 同机读原文件，提供刷新；异机时下载为可移植副本，只在录制端写，返回后用 `collection-plan import-progress` 合并。导入仅修改进度，校验同一 `plan_id`、`generation`、不可变内容和合法非冲突转换；录制副本还在使用时不再生成，不支持跨代双写/同步。

**Verification**

1. [x] 两仓用同一最小计划样例覆盖格式、完整性、SHA、状态与 episode 约束；Python 覆盖状态转换、原子替换故障、并发或录制已持锁、幂等重试和导入冲突。演示独立读取导出文件并模拟写进度。

**Done**

- [x] `lerobot-check/docs/collection-plan.md` 载明字段、锁、状态机、格式版本、传输和 #5 接入示例；无需从 viewer 代码推导契约。

### Task: 组合轮次并用已采位置重新采样

**Change**

- [x] `lerobot-check collection-plan` 读取 distribution、可选 target polygon、`head.json` 和审核模板；模板可显式给定，viewer 采用 `.xense-viewer/mask-templates/<slug>@<revision>/` 的同契约 JSON。生成 N 个待采轮次、每轮恰好 K 个不同物体。K 可取 1 到分布中全部物体数；优先轮转较少采用的物体，候选沿用 `suggest` 的覆盖优先级和种子。候选必须有在画幅内的有效锚点，且对有审核模板的物体必须能投影完整轮廓。带种子的有界组合搜索遇碰撞换位置、换物体组合；找不足 N 则报请求和可构造轮数/失败原因，不覆盖现有计划，不把搜索预算耗尽说成数学上无解。
- [x] 对每个有模板的目标，用 `mask-overlays` 同一局部外形、对称 yaw、位置和高度，还原到基座空间；跨臂经头相机标定变换到同一基座坐标。取外形在共同 XY 平面上的保守凸包，拒绝相交或接触；轮次内同时用原生像素凸包拒绝可视重叠。结论只针对规划目标的平面近似，不声称验证厚度、未规划物体或实物误差。`box_base` 已证实纸垫释放不能代理盒底，当前模板显式拒绝投影。它（及其他无可信轮廓对象）允许进入 K=1 的人工确认轮，保留位置、箭头和原因；K>1 不纳入，告知被排除物体；K 超过可检查物体数则明确报错，不画假轮廓或承诺无碰撞。
- [x] 再生成保留 `collected` 与 `skipped` 原轮次、位置和编号，只替换 `pending`；跳过不计覆盖、不阻止后续摆同一位置。把每个已采目标作为分布的临时补充观测；如果 distribution 已有该 `object` + `episode_index` 的真实观测，则只保留真实观测计数，防止重复。以现有 XY 分箱宽度的一半作为同物体最小重访距离，与 yaw 无关，也检查已入选的新目标；有真实后续观测则同时避开原计划位置和该观测。使用覆盖统计促使采样填空，再以硬距离约束阻止同位置换 yaw 后被选中。不改磁盘上的 distribution；校准身份与原计划不同则拒绝，避免历史几何被误用。

**Verification**

1. [x] 合成几何测试覆盖凸包触碰/相交/不相交、跨臂、组合重试和短缺、单物体无轮廓、多物体排除和同种子。另验证覆盖计数增量、实际观测去重、跳过不计以及生成失败不替换文件。
2. [x] 本机真实 `Xense/pack_iphone_box_1119`、D435 标定和 #1 审核模板在隔离数据根生成多物体计划。用模拟保存为两轮写实际零基格式的 episode 编号，不生成真实 episode；同种子再生成，输出所有新目标对同物体已采锚点的最近距离、阈值及轮次内碰撞检查结果，并确认已采轮次未变。用 `uv run pytest`、Ruff 和类型检查验证。

**Done**

- [x] 可复跑的本地验收文件记录旧计划、模拟已采后的计划、再生成计划及最小距离和碰撞证明，报告明确区分模拟进度与真实采集。

### Task: COLLECTION 展示轮次、进度并导出

**Change**

- [x] 扩展 collection store、route 与现有 lerobot-check runner，新增读取/生成计划路径；TS 读和导出，Python 是唯一写者。未配置 CLI 时给复制命令。复用参考头图和画布，把选中轮的所有目标同时画出，保留现有按点与测试点模式。显示计划轮次列表及三个状态、已采 episode 编号、整体进度、每轮物体数和需要再生成的轮数、失败与不可投影的原因。待采轮可逐轮删除或重抽，其他轮次的目标、相对顺序和进度不变；重抽保留原物体数，替换内容并分配新 ID，避开已采及其余待采轮和被替换目标。用 `plan_id` 和 `generation` 拒绝过期审核请求；每次几何编辑推进一代，进度更新不推进。支持刷新外部写入，确认后导出已审核版本的磁盘 JSON，补充中英文本。

**Verification**

1. [x] Viewer 跑 `bun run format && bun run validate`，用测试覆盖有效/错误计划、本地状态刷新、导出与已选轮多物体绘制的数据流。浏览器在真实参考头图上选一轮看多个轮廓，模拟进度后刷新，切换每轮物体数并再生成，逐轮删除、重抽并确认其他轮次保持不变，确认后下载并用 Python 解析核对内容。
2. [x] 把初始多轮、已采与已跳过的进度、再生成后的轮次和截图绝对路径记入隔离验收目录 `/home/atticuszz/DevSpace/vla-post-train-artifacts/collection-plan-issue-4`；项目提交仅含合成样例、代码和文档。本地开发服务验收后已停止。

**Done**

- [x] COLLECTION 图能看出同轮轮廓及持久化进度，下载文件能由独立进度读取器处理。独立复核的 63 对轮内目标在头图与共同基座平面上均无交叠；12 个新目标距同物体最近已采锚点的最小值为 45.4 mm，阈值为 25 mm。
