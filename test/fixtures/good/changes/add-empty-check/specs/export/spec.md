# 导出接口 规范

### Requirement: 系统必须拒绝空输入

#### Scenario: 空字符串入参
- **GIVEN** 客户端发送 `POST /export` 且 body 为空字符串
- **WHEN** 服务端收到该请求
- **THEN** 返回 400 与错误码 `E_EMPTY_INPUT`

### Requirement: 系统必须保持非空入参行为不变

#### Scenario: 正常导出
- **GIVEN** 客户端发送合法的 ID 列表
- **WHEN** 服务端处理该请求
- **THEN** 返回 200 与压缩包字节流

#### Scenario: 仅空白字符
- **GIVEN** 客户端发送三个空格组成的 body
- **WHEN** 服务端收到该请求
- **THEN** 返回 400 与错误码 `E_EMPTY_INPUT`
