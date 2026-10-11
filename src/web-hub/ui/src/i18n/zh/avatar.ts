import en from "../en/avatar.js";

type Messages<T> = { [K in keyof T]: string };

const avatar = {
  title: "你的头像",
  hint: "显示在你的消息旁，并在所有设备同步。图片会居中裁成正方形并缩放到 256 像素。",
  upload: "上传图片",
  remove: "移除",
  removeConfirm: "确认移除头像",
  removeArmed: "再次点击“移除”以确认",
  processing: "正在准备头像…",
  errorSourceTooLarge: "源图片超过 20 MiB",
  errorSourceUnknown: "无法识别这张图片的格式",
  errorSourceDims: "图片尺寸不受支持",
  errorDecode: "图片无法解码",
  errorEncode: "图片无法编码",
  errorUnsupported: "此浏览器生成的图片不受支持",
  errorSignature: "生成的图片 PNG 签名无效",
  errorIhdr: "生成的图片 PNG 头部无效",
  errorDims: "生成的图片尺寸不受支持",
  errorColor: "生成的图片颜色格式不受支持",
  errorChunk: "生成的图片包含不支持的 PNG 块",
  errorCrc: "生成的图片完整性校验失败",
  errorAnimated: "不支持动画图片",
  errorOrder: "生成的图片 PNG 块顺序无效",
  errorTrailing: "生成的图片包含尾随数据",
  errorIdat: "生成的图片图像数据无效",
  errorSize: "生成的图片过大",
  errorTooLarge: "头像超过 hub 的大小限制",
  errorBusy: "hub 正忙，请稍后重试",
  errorRate: "头像请求过多，请稍后重试",
  errorRateAfter: "头像请求过多，请在 {n} 秒后重试",
  errorAuth: "登录状态已过期，请重新登录",
  errorDeadline: "头像请求超时，请重试",
  errorDeadlineUnknown: "结果未知，请刷新确认",
  errorGeneric: "头像更新失败",
} satisfies Messages<typeof en>;

export default avatar;
