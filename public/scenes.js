/**
 * 大屏播放画面的背景照片。
 *
 * 全部来自 Unsplash（Unsplash License：可免费使用、可再分发、不要求署名），
 * 所以可以放进公开仓库。id 是 images.unsplash.com/photo-<id> 里的那一段，
 * 留着它是为了以后能找回原图和作者。
 *
 * 不要换成 Pinterest、Canva 或别人歌单视频里的截图 ——
 * 前者版权不明，Canva 免费素材禁止单独分发，后者是他人原创。
 *
 * 分白天、晚上两组：深夜切出一张阳光满屋的照片很出戏。
 */
export const SCENES = {
  day: [
    { file: "day-01.jpg", id: "1445116572660-236099ec97a0" },
    { file: "day-02.jpg", id: "1554118811-1e0d58224f24" },
    { file: "day-03.jpg", id: "1521017432531-fbd92d768814" },
    { file: "day-04.jpg", id: "1485182708500-e8f1f318ba72" },
    { file: "day-05.jpg", id: "1525610553991-2bede1a236e2" },
    { file: "day-06.jpg", id: "1525648199074-cee30ba79a4a" },
    { file: "day-07.jpg", id: "1442975631115-c4f7b05b8a2c" },
    { file: "day-08.jpg", id: "1600093463592-8e36ae95ef56" },
    { file: "day-09.jpg", id: "1493857671505-72967e2e2760" },
  ],
  night: [
    { file: "night-01.jpg", id: "1501339847302-ac426a4a7cbb" },
    { file: "night-02.jpg", id: "1442512595331-e89e73853f31" },
    { file: "night-03.jpg", id: "1481833761820-0509d3217039" },
    { file: "night-04.jpg", id: "1514933651103-005eec06c04b" },
    { file: "night-05.jpg", id: "1517248135467-4c7edcad34c4" },
    { file: "night-06.jpg", id: "1463797221720-6b07e6426c24" },
    { file: "night-07.jpg", id: "1414235077428-338989a2e8c0" },
    { file: "night-08.jpg", id: "1520523839897-bd0b52f945a0" },
  ],
};

/** 几点算白天。按本地时间，7:00–18:59 */
export function periodOf(date) {
  const h = date.getHours();
  return h >= 7 && h < 19 ? "day" : "night";
}
