# [能力名称] 规范

> 每条 Requirement 必须至少有一个 Scenario，且 GIVEN / WHEN / THEN 齐全。
> 一个 Scenario 只描述**一个**行为——出现第二个 THEN 就拆开。

### Requirement: [需求一句话，用"系统必须……"表述]

#### Scenario: [场景名]
- **GIVEN** [初始状态]
- **WHEN** [单一动作或事件]
- **THEN** [单一、可观察的结果]

---

### Requirement: [第二条需求]

#### Scenario: [正常路径]
- **GIVEN** [初始状态]
- **WHEN** [动作]
- **THEN** [结果]

#### Scenario: [边界/失败路径]
- **GIVEN** [初始状态]
- **WHEN** [触发边界的动作]
- **THEN** [明确的错误行为，含错误码或错误信息]
