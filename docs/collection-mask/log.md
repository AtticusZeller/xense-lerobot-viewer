## 补采目标 mask（viewer #1）

实现 COLLECTION 的补采位置和密集、边缘、空白测试点 mask 预览，以及采集前对着头部 RGB 视频摆物。采样策略、训练/推理提示、自动对齐及采集程序不变。不连机器人，不修改 Hub 数据集，不提交真实数据、标定或生成图。

已核对：`collection-panel.tsx` 从 `collection-store.ts` 读取 sidecar，把建议项绘制在参考 episode 的首帧上；`suggest` 输出每个物体的 `arm/z_plane_m/yaw_symmetry_deg` 及每个点的 base-frame `x_m/y_m/z_m/yaw_deg`。`lerobot-check` 已有带 intrinsics/畸变的 `backproject_pixels_to_plane_z` / `project_base_points`；分布的 `poses` 保存 `grasp` 或 `end - 1` 的校准 tool point 和 TCP 原始 yaw。该点不是物体中心，尤其 `box_base` 使用纸垫释放事件作为代理。本机有真实 `head.json` 和头部 MP4（D435 RGB8，640×480、30 fps，零畸变，右臂留一交叉校验均方根误差约 2.09 px）；现有 suggestions 的 z 已和当前 distribution 不一致，在隔离目录重新生成整套输出。`lsusb` 没有 RealSense，有 Syntek 内置 UVC `/dev/video0`，设备可读且枚举到 640×480；未开流。笔记本相机不沿用 D435 的标定，只做摄像头路径冒烟。`lerobot-xense` Flexiv 配置使用 `intelrealsense`；采集端通过 `make_cameras_from_configs` 和 `async_read()` 读 RGB，可选另读深度。

### Task: 离线建立物体轮廓并投影到所有建议项

**Change**

- [x] `lerobot-check` 加 `mask-template`，用已有 `DatasetView`/PyAV 以 v3 视频分段起点加 episode 帧时间提取原始分辨率的头图，支持预览和读取框提示（可给正/负点细化）；从已审核 episode 的 `grasp`/放稳（`end - 1`）事件附近选每个物体一帧。抓取时优先用夹爪尚未遮挡、物体还未移动的临近帧，放稳时优先用夹爪已让开、物体未动的帧，图像帧与用作位姿锚定的事件帧分别记录。操作员看 cutout 后才采用模板。不批量分割或推理视频。
- [x] 模型用 Transformers 内置 `Sam2Model`/`Sam2Processor` 跑 `facebook/sam2.1-hiera-tiny`，固定模型版本；权重 `model.safetensors` 为 155.9 MB（Hub dry-run），只在首次显式下载或已有本地权重时使用。`uv add --optional` 管理 Transformers 等分割依赖，新增 Python wheel 预计数十 MB，PyTorch/torchvision 原已随 LeRobot 安装（本机 2.10.0/0.25.0；从空白装 CUDA 运行时仍是 GB 级）。不编译 Meta CUDA 扩展；一次性 CPU/CUDA 可选。Viewer 和采集端都不装模型。
- [x] 模板保存来源、标定身份、物体/arm、参考 `(x,y,raw_yaw)`（用 distribution 已校准的 tool point，不挪到轮廓中心）及闭合外轮廓的物体局部米制坐标。把源轮廓像素反投影到该物体建议平面，减参考 `(x,y)`，旋转 `-yaw_ref`；绘制时旋转到目标 yaw、加目标 `(x,y)`，在目标平面 z 上经相应 arm 的 `T_cam_base` 和头部内参投影。对明显偏离可见表面的工具点平面允许显式 per-object 高度偏移（源/目标一致，默认零）。用 `yaw_symmetry_deg` 选择离参考角最近的等价目标方向（固定边界 tie；180° 两向等价；360° 保留首尾）。这是固定相机下的单平面外形近似，不能恢复侧面/厚度；box_base 的 release yaw 仅是代理，验收单独看它是否重现可接受方向，不改 `suggest` 的坐标/抽样语义。
- [x] 加 `mask-overlays` 读取现有 suggestions、`head.json` 和已审核模板，写独立的 `.xense-viewer/masks/<slug>@<revision>.json`。不改旧 suggestions/CSV。单一 v1 JSON 可拷贝到采集机：带 dataset/revision/camera/image_size、标定/建议文件 SHA-256、物体与源帧来源、按 `(kind,object,index)` 标识补采轮廓，测试点还用 `tier` 区分。补采的采样优先级保留在 `suggestions.json`，不进入 bundle。缺模板或无法有效投影的点显式标注原因；不画假轮廓。读取旧文件仍看点/箭头；建议或标定改变后旧 mask 不显示，须重生成。

**Verification**

1. [x] Python 测试覆盖 v3 视频分段、参考回投、XY 平移和已知旋转/畸变、不同臂、180°/360° 的区别、坏投影与缺模板，不依赖下载；一次本机真实 SAM 推理生成四个物体模板和 source/mask 对照 PNG。
2. [x] 使用真实 D435 标定生成所有 placements/test_points，核对点数和四类覆盖，另以不同于模板源的可见事件逐物体对照预测轮廓和真实物体，记录可见误差/局限。不能用模板原帧重投来证明跨位置准确性。

**Done**

- [x] 用真实 `pack_iphone_box_1119` 标定生成了三个物体的全部 57 个轮廓。第四个物体 `box_base` 的外形能正确分割，但将纸垫释放姿态当作盒底锚点时，在独立 episode 上偏离约 10 px、15°；其 19 个目标均保留点和箭头，轮廓显式标为不可用。

### Task: COLLECTION 预览同一份可携带的目标 mask

**Change**

- [x] Viewer 的 collection store 读取并校验 bundle，复用现有头图画布；点选一行查看目标 mask，保留点/箭头和各类过滤，当前选中的轮廓进入 PNG。提供 bundle JSON 下载；保持 CSV 不变。缺失、过期或尺寸不符时显示原因，不把近似画到错误画幅。增加中英文界面文字，不让 viewer 调模型或访问相机。

**Verification**

1. [x] TS schema/store/选择测试覆盖无 sidecar、正常、过期、分辨率、旧 suggestions。`bun run format && bun run validate`。
2. [x] 本机浏览器在真实参考头图上切换补采点与三类测试点；截图/录屏证明不同目标的轮廓跟随选中项，导出 PNG 可见轮廓，导出的 JSON 能直接被下一步打开。

**Done**

- [x] 提交本机可重开的 COLLECTION 与 PNG 证据，不变更在线数据。

### Task: 独立采集前预览，不加入机器人或数据集进程

**Change**

- [x] 在 viewer 仓库 `scripts/` 加隔离的 `uv run` Python 小窗（OpenCV GUI，非 lerobot-check 的 headless 环境）。同一便携 bundle，窗口提示 A/D 切换、Q/Esc 退出，显示同号点的物体、编号、类别和朝向箭头；实时端读投影结果，不重跑几何/SAM。按摄像头原生坐标先合成再缩放窗口。
- [x] 输入支持以录制帧率循环播放本地 MP4、V4L2 webcam 和可选 `pyrealsense2` 直接打开指定序列号的 RGB8 color stream（跟现有头相机参数一致，不开 depth、不实例化机器人）。预览在采集进程尚未占用相机时运行，退出释放设备后再开始录制；不承诺同采集进程并行共享。实际分辨率不一致拒绝叠加；不会对图像镜像、裁剪或暗中把任意相机当成已标定设备。相机需保留标定对应的外参/安装角度，仅分辨率匹配还不够。
- [x] 本期不显示自动“已对齐”。未来如要做，先收集真机正/负样本，再用现场分割、按对称周期比较方向、用 IoU 和平面位姿误差标定阈值；无有效分割时不得判定已对齐。本期不编造阈值。

**Verification**

1. [x] 用真实 640×480 MP4 当实时源录屏，播放中切换至少两个目标，证明底图持续变化、目标轮廓相对像素固定并按所选目标切换；用同一 bundle 做像素一致性测试及尺寸不符的负例。本机通用摄像头只做设备枚举；未用其验证几何。
2. [ ] 真机留给采集端主人：用同一 D435/序列号、RGB profile、镜头和原标定机位，在未启动采集时选多个远近及朝向不同的点，把实物移入轮廓并复验（含 iPhone 首尾），退出后确认采集程序能重新打开相机。若摄像头或工作平面变动，重标定并重新生成。

**Done**

- [x] 两仓 README 分别记录模板生成、预览安装和采集前切换流程。`lerobot-check` 负责离线分割与投影契约，viewer 负责可视化与采集前小窗；没有修改 `lerobot-xense`。
