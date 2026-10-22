/**
 * AI 配置面板组件。
 *
 * 功能：
 * - AI 总开关、协议选择（Anthropic Messages / OpenAI 兼容 / Ollama）
 * - API Key 输入（显示掩码，编辑时替换）
 * - 模型选择（从接入地址实时查询）、自定义 URL（决定实际接入的供应商）
 * - 连接测试
 * - AI 判定和分析的子开关
 * - 配置方案：必须先新增方案才能编辑，所有编辑归属于当前方案
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { isAxiosError } from 'axios'
import {
  Card, Form, Input, Select, AutoComplete, Switch, Button, Space, Alert,
  Typography, Divider, InputNumber, Tooltip, Spin, Radio, Modal, Popconfirm,
  message,
} from 'antd'
import {
  RobotOutlined, ApiOutlined, ThunderboltOutlined,
  CheckCircleOutlined, CloseCircleOutlined,
  PlusOutlined, DeleteOutlined, SwapOutlined, ReloadOutlined,
} from '@ant-design/icons'
import {
  getAIConfig, setAIConfig, testAIConnection, listAIModels,
  listAIProfiles, createAIProfile, activateAIProfile, deleteAIProfile,
} from '../api/axios'
import type { AIConfig, AIProfileSummary } from '../types'

const { Text } = Typography
const PROTOCOL_OPTIONS = [
  { value: 'anthropic', label: 'Anthropic Messages 协议' },
  { value: 'openai', label: 'OpenAI 兼容协议（Chat Completions）' },
  { value: 'ollama', label: 'Ollama 原生协议（/api/chat）' },
]

export default function AIConfigPanel() {
  const [form] = Form.useForm<AIConfig>()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [config, setConfig] = useState<AIConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 配置方案
  const [profiles, setProfiles] = useState<AIProfileSummary[]>([])
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [profileName, setProfileName] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  // 模型列表（从接入地址查询，查询失败保持为空，可手动输入）
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  // 丢弃过期请求的结果，避免快速切换协议时列表串台
  const modelRequestId = useRef(0)

  const currentProtocol = Form.useWatch('ai_protocol', form) || 'anthropic'

  const getErrorMessage = (err: unknown, fallback: string) => {
    if (isAxiosError<{ detail?: string }>(err)) {
      return err.response?.data?.detail || err.message || fallback
    }
    if (err instanceof Error) return err.message
    return fallback
  }

  const loadConfig = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await getAIConfig()
      setConfig(res.data)
      // 后端不回显完整密钥，明确清空输入框，避免把上一方案的密钥带到新方案
      form.setFieldsValue({ ...res.data, ai_api_key: '' })
      setError(null)
    } catch (err) {
      setError(getErrorMessage(err, '加载 AI 配置失败'))
    } finally {
      if (!silent) setLoading(false)
    }
  }, [form])

  const loadProfiles = useCallback(async () => {
    try {
      const res = await listAIProfiles()
      setProfiles(res.data.profiles)
      setActiveProfileId(res.data.active_id)
    } catch (err) {
      setError(getErrorMessage(err, '加载配置方案失败'))
    }
  }, [])

  /** 从当前表单的协议 / 接入地址查询模型列表；失败静默清空，可继续手动输入。 */
  const fetchModels = useCallback(async () => {
    const values = form.getFieldsValue([
      'ai_protocol', 'ai_base_url', 'ai_api_key',
    ]) as { ai_protocol?: string; ai_base_url?: string; ai_api_key?: string }

    const requestId = ++modelRequestId.current
    setLoadingModels(true)
    try {
      const res = await listAIModels({
        ai_protocol: values.ai_protocol || 'anthropic',
        ai_base_url: values.ai_base_url || '',
        ai_api_key: values.ai_api_key || '',
      })
      if (requestId === modelRequestId.current) {
        setModelOptions(res.data.models.map((m) => ({ value: m.id, label: m.label })))
      }
    } catch {
      if (requestId === modelRequestId.current) setModelOptions([])
    } finally {
      if (requestId === modelRequestId.current) setLoadingModels(false)
    }
  }, [form])

  useEffect(() => {
    loadConfig()
    loadProfiles()
  }, [loadConfig, loadProfiles])

  // 协议或配置方案变化后，按新的接入地址重新查询（防抖）
  useEffect(() => {
    if (loading) return
    const timer = setTimeout(() => { void fetchModels() }, 400)
    return () => clearTimeout(timer)
  }, [currentProtocol, activeProfileId, loading, fetchModels])

  const handleSave = async () => {
    if (!activeProfileId) {
      message.warning('请先新增一套配置方案')
      return
    }
    try {
      const values = await form.validateFields()
      setSaving(true)
      setTestResult(null)
      await setAIConfig(values)
      await loadConfig()
      await loadProfiles()
    } catch (err) {
      if (isAxiosError(err)) setError(getErrorMessage(err, '保存 AI 配置失败'))
    } finally {
      setSaving(false)
    }
  }

  /** 切换配置方案：后端把方案快照写回当前配置，前端重新加载表单。 */
  const handleSwitchProfile = async (id: string) => {
    if (!id || id === activeProfileId) return
    setSwitching(true)
    setTestResult(null)
    try {
      const res = await activateAIProfile(id)
      setActiveProfileId(id)
      await loadConfig(true)
      await loadProfiles()
      message.success(res.data.message)
    } catch (err) {
      setError(getErrorMessage(err, '切换配置方案失败'))
    } finally {
      setSwitching(false)
    }
  }

  const handleOpenSaveAs = () => {
    const active = profiles.find((p) => p.id === activeProfileId)
    setProfileName(active ? `${active.name} 副本` : '')
    setSaveAsOpen(true)
  }

  /** 新增配置：以表单当前值创建新方案并设为激活方案，不修改原方案。 */
  const handleSaveAsConfirm = async () => {
    const name = profileName.trim()
    if (!name) {
      message.warning('请输入配置方案名称')
      return
    }
    try {
      const values = await form.validateFields()
      setSavingProfile(true)
      const res = await createAIProfile(name, values)
      setActiveProfileId(res.data.profile.id)
      await loadConfig(true)
      await loadProfiles()
      setSaveAsOpen(false)
      setProfileName('')
      message.success(res.data.message)
    } catch (err) {
      if (isAxiosError(err)) setError(getErrorMessage(err, '保存配置方案失败'))
    } finally {
      setSavingProfile(false)
    }
  }

  const handleDeleteProfile = async () => {
    if (!activeProfileId) return
    try {
      const res = await deleteAIProfile(activeProfileId)
      // 删除激活方案时后端会自动切换到剩余方案，这里重新加载
      await loadConfig(true)
      await loadProfiles()
      message.success(res.data.message)
    } catch (err) {
      setError(getErrorMessage(err, '删除配置方案失败'))
    }
  }

  const handleTest = async () => {
    if (!activeProfileId) {
      message.warning('请先新增一套配置方案')
      return
    }
    // 先保存再测试
    try {
      const values = await form.validateFields()
      setTesting(true)
      setTestResult(null)
      await setAIConfig(values)
      const res = await testAIConnection()
      setTestResult(res.data)
    } catch (err) {
      setTestResult({ ok: false, message: getErrorMessage(err, '连接测试失败') })
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <Spin tip="加载 AI 配置..." />
      </Card>
    )
  }

  return (
    <Card
      title={
        <Space>
          <RobotOutlined />
          <span style={{ fontSize: 15, fontWeight: 600 }}>AI 智能辅助配置</span>
        </Space>
      }
      extra={
        <Space>
          <Button
            icon={<ApiOutlined spin={testing} />}
            onClick={handleTest}
            loading={testing}
            disabled={!activeProfileId}
          >
            测试连接
          </Button>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={handleSave}
            loading={saving}
            disabled={!activeProfileId}
          >
            保存配置
          </Button>
        </Space>
      }
      style={{ maxWidth: 560 }}
    >
      {error && (
        <Alert
          type="error"
          message={error}
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 16 }}
        />
      )}

      {testResult && (
        <Alert
          type={testResult.ok ? 'success' : 'error'}
          message={testResult.ok ? 'AI 连接成功' : 'AI 连接失败'}
          description={testResult.message}
          icon={testResult.ok ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
          showIcon
          closable
          onClose={() => setTestResult(null)}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* 配置方案：多套配置保存与切换 */}
      <div
        style={{
          marginBottom: 16,
          padding: '12px 14px',
          background: 'rgba(22, 119, 255, 0.04)',
          border: '1px solid rgba(22, 119, 255, 0.15)',
          borderRadius: 8,
        }}
      >
        <Space wrap>
          <Space size={6}>
            <SwapOutlined style={{ color: '#1677ff' }} />
            <Text strong style={{ fontSize: 14 }}>配置方案</Text>
          </Space>
          <Select
            style={{ minWidth: 220 }}
            placeholder={profiles.length ? '选择已保存的方案' : '暂无已保存的方案'}
            value={activeProfileId ?? undefined}
            onChange={handleSwitchProfile}
            options={profiles.map((p) => ({
              value: p.id,
              label: `${p.name}（${p.ai_model || p.ai_protocol}）`,
            }))}
            disabled={switching}
            loading={switching}
            allowClear={false}
          />
          <Button
            type={profiles.length ? 'default' : 'primary'}
            icon={<PlusOutlined />}
            onClick={handleOpenSaveAs}
          >
            新增配置
          </Button>
          {activeProfileId && (
            <Popconfirm
              title="删除当前配置方案？"
              description="删除后会自动切换到剩余方案；若没有剩余方案，AI 配置将变为不可编辑。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={handleDeleteProfile}
            >
              <Button danger icon={<DeleteOutlined />}>删除方案</Button>
            </Popconfirm>
          )}
        </Space>
        <div style={{ marginTop: 6 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            所有编辑都归属于当前选中的配置；点击「保存配置」写回该方案，切换方案会立即应用其中的协议、地址、模型与密钥。
          </Text>
        </div>
      </div>

      {!activeProfileId && (
        <Alert
          type="info"
          showIcon
          message="请先新增一套配置方案"
          description="要先有一套配置方案才能编辑和保存 AI 配置。点击「新增配置」创建后会立即切换到该方案。"
          style={{ marginBottom: 16 }}
        />
      )}

      <Form
        form={form}
        layout="vertical"
        disabled={!activeProfileId}
        initialValues={config || {}}
      >
        {/* 总开关 */}
        <Form.Item
          name="ai_enabled"
          label={<Text strong style={{ fontSize: 14 }}>启用 AI 功能</Text>}
          valuePropName="checked"
        >
          <Switch
            checkedChildren="已启用"
            unCheckedChildren="已禁用"
            style={{ minWidth: 80 }}
          />
        </Form.Item>

        <Divider style={{ margin: '12px 0' }} />

        {/* 协议选择（供应商由 URL + 模型决定） */}
        <Form.Item
          name="ai_protocol"
          label="AI 协议"
          rules={[{ required: true }]}
          style={{ maxWidth: 360 }}
        >
          <Select options={PROTOCOL_OPTIONS} />
        </Form.Item>

        {/* API Key（Anthropic/OpenAI 兼容需要，Ollama 不需要）*/}
        {currentProtocol !== 'ollama' && (
          <Form.Item
            name="ai_api_key"
            label="API Key"
            style={{ maxWidth: 400 }}
            extra={
              config?.ai_api_key_masked
                ? <Text type="secondary">当前: {config.ai_api_key_masked}（留空保留原密钥）</Text>
                : <Text type="secondary">尚未配置 API Key</Text>
            }
          >
            <Input.Password
            placeholder="输入新的 API Key（留空保留已有）"
            onBlur={() => { void fetchModels() }}
          />
          </Form.Item>
        )}

        {/* 模型选择：从接入地址查询，也支持手动输入 */}
        <Form.Item
          label="模型"
          style={{ maxWidth: 420 }}
          extra={
            <Text type="secondary" style={{ fontSize: 12 }}>
              列表从接入地址自动获取，获取不到时可直接手动输入模型名称
            </Text>
          }
        >
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item name="ai_model" noStyle>
              <AutoComplete
                options={modelOptions}
                allowClear
                style={{ width: '100%' }}
                placeholder="选择或输入模型名称"
                notFoundContent={
                  loadingModels
                    ? <Spin size="small" />
                    : '未获取到模型列表，可直接输入'
                }
                filterOption={(inputValue, option) => {
                  const keyword = inputValue.toLowerCase()
                  return String(option?.label ?? '').toLowerCase().includes(keyword)
                    || String(option?.value ?? '').toLowerCase().includes(keyword)
                }}
              />
            </Form.Item>
            <Tooltip title="从接入地址重新获取模型列表">
              <Button
                icon={<ReloadOutlined spin={loadingModels} />}
                onClick={() => { void fetchModels() }}
              />
            </Tooltip>
          </Space.Compact>
        </Form.Item>

        {/* 接入地址：与协议、模型共同决定实际供应商 */}
        <Form.Item
          name="ai_base_url"
          label={
            <Tooltip title="接入哪个供应商由 协议 + 地址 + 模型 共同决定：Anthropic 网关填 https://llm.thundersoft.com；OpenAI 兼容服务填以 /v1 结尾的地址；Ollama 填服务根地址。">
              接入地址（Base URL）
            </Tooltip>
          }
          extra={<Text type="secondary" style={{ fontSize: 12 }}>留空则使用协议默认地址</Text>}
          style={{ maxWidth: 420 }}
        >
          <Input
            placeholder={
              currentProtocol === 'ollama'
                ? 'http://localhost:11434（默认）'
                : currentProtocol === 'openai'
                  ? '留空用 https://api.openai.com/v1；兼容端点如 http://10.10.134.16:8081/v1'
                  : '留空用 Anthropic 官方地址；网关如 https://llm.thundersoft.com'
            }
            onBlur={() => { void fetchModels() }}
          />
        </Form.Item>

        <Divider style={{ margin: '12px 0' }}>
          <Text type="secondary">功能开关</Text>
        </Divider>

        {/* AI 判定模式 */}
        <Form.Item
          name="ai_judge_mode"
          label={
            <Tooltip title="启用 AI 判定后优先采用 AI 结果：始终 = 每个用例执行后都调 AI 判定 Pass/Fail；仅不确定时 = 规则引擎置信度 < 0.8 时才调 AI；关闭 = 仅用规则引擎。AI 不可用或返回异常时自动回退规则引擎。">
              AI 判定模式
            </Tooltip>
          }
        >
          <Radio.Group buttonStyle="solid" size="small">
            <Radio.Button value="always">始终 AI 判定</Radio.Button>
            <Radio.Button value="uncertain">仅不确定时</Radio.Button>
            <Radio.Button value="off">关闭</Radio.Button>
          </Radio.Group>
        </Form.Item>

        {/* AI 步骤智能识别 */}
        <Form.Item
          name="ai_auto_parse_steps"
          label={
            <Tooltip title="上传用例后自动调用 AI 识别测试步骤中的命令，提高未识别步骤的覆盖率">
              <Text strong style={{ fontSize: 14 }}>AI 识别测试步骤</Text>
            </Tooltip>
          }
          valuePropName="checked"
        >
          <Switch
            checkedChildren="开"
            unCheckedChildren="关"
            style={{ minWidth: 60 }}
          />
        </Form.Item>

        {/* 自动分析所有 Fail */}
        <Form.Item
          name="ai_auto_analyze"
          label={
            <Tooltip title="执行完成后自动分析所有 Fail 用例，生成失败原因摘要">
              <Text strong style={{ fontSize: 14 }}>自动分析所有 Fail 用例</Text>
            </Tooltip>
          }
          valuePropName="checked"
        >
          <Switch
            checkedChildren="开"
            unCheckedChildren="关"
            style={{ minWidth: 60 }}
          />
        </Form.Item>

        {/* 缓存 TTL */}
        <Form.Item name="ai_cache_ttl_hours" label="缓存有效期（小时）" style={{ maxWidth: 180 }}>
          <InputNumber min={1} max={168} style={{ width: 120 }} />
        </Form.Item>
      </Form>

      <Modal
        title="新增配置方案"
        open={saveAsOpen}
        okText="创建"
        cancelText="取消"
        confirmLoading={savingProfile}
        onOk={handleSaveAsConfirm}
        onCancel={() => setSaveAsOpen(false)}
      >
        <div style={{ marginBottom: 8 }}>
          <Text type="secondary">以当前配置为基础创建一套新方案；创建后它会成为当前方案，可直接编辑。</Text>
        </div>
        <Input
          placeholder="例如：中智网关 / 本地 Ollama"
          value={profileName}
          onChange={(e) => setProfileName(e.target.value)}
          onPressEnter={handleSaveAsConfirm}
          maxLength={32}
          showCount
          autoFocus
        />
      </Modal>
    </Card>
  )
}
