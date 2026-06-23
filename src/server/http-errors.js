export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export class UploadTooLargeError extends HttpError {
  constructor(maxUploadMb) {
    super(413, `文件过大，请上传 ${maxUploadMb}MB 以内的 PLT 文件`);
    this.name = "UploadTooLargeError";
  }
}

export class ConversionTimeoutError extends HttpError {
  constructor(message = "转换超时，请尝试简化文件或稍后重试") {
    super(504, message);
    this.name = "ConversionTimeoutError";
  }
}
