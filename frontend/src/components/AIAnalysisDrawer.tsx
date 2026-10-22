/**
 * AI 失败分析抽屉组件。
 *
 * 功能：
 * - 单用例 AI 失败分析（展示根因分类、摘要、证据、建议）
 * - 分析结果缓存（同一用例不重复调用）
 * - 置信度可视化
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Drawer, Button, Tag, Space, Alert, Spin, Typography,
  Progress, Descriptions, List, Divider, Card, Empty,
} from 'antd'
import {
  BugOutlined, ExperimentOutlined,
  EnvironmentOutlined, SyncOutlined, QuestionCircleOutlined,
  BulbOutlined, CheckCircleOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { analyzeFailureStream } from '../api/axios'
import type { AIAnalysis, TestCase } from '../types'

const { Text, Title, Paragraph } = Typography

// 根因分类图标和颜色
const CATEGORY_MAP: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  environment: { label: '环境问题', icon: <EnvironmentOutlined />, color: 'blue' },
  defect:      { label: '软件缺陷', icon: <BugOutlined />, color: 'red' },
  test_issue:  { label: '用例问题', icon: <ExperimentOutlined />, color: 'orange' },
  flaky:       { label: '偶发失败', icon: <SyncOutlined />, color: 'purple' },
  mismatch:    { label: '预期偏差', icon: <QuestionCircleOutlined />, color: 'gold' },
}

interface Props {
  open: boolean
  onClose: () => void
  /** 当前正在分析的用例 */
  testCase: TestCase | null
  /** 缓存的分析结果（父组件管理） */
  cachedAnalysis?: AIAnalysis | null
  /** 分析完成回调（供父组件缓存结果） */
  onAnalysisDone?: (caseKey: string, analysis: AIAnalysis) => void
}

export default function AIAnalysisDrawer({
  open, onClose, testCase, cachedAnalysis, onAnalysisDone,
}: Props) {
  const [loading, setLoading] = useState(false)
  const [analysis, setAnalysis] = useState<AIAnalysis | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 流式输出的原始文本（模型正在生成的 JSON） */
  const [streamText, setStreamText] = useState('')
  /** 思考型模型的推理过程（首个正式输出前的实时反馈） */
  const [thinkingText, setThinkingText] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const streamRef = useRef<HTMLDivElement | null>(null)
  const thinkingRef = useRef<HTMLDivElement | null>(null)

  // 有缓存则直接使用
  useEffect(() => {
    if (cachedAnalysis) {
      setAnalysis(cachedAnalysis)
      setError(null)
    } else {
      setAnalysis(null)
    }
  }, [cachedAnalysis, testCase])

  // 切换用例时中断上一个用例尚未完成的流
  useEffect(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setLoading(false)
    setStreamText('')
    setThinkingText('')
    setError(null)
  }, [testCase?.case_key, testCase?.case_id])

  const doAnalyze = useCallback(async (force = false) => {
    if (!testCase) return

    // 丢弃上一次未完成的流
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    setLoading(true)
    setError(null)
    setStreamText('')
    setThinkingText('')

    const caseKey = testCase.case_key || testCase.case_id
    const isCurrent = () => abortRef.current === controller
    try {
      await analyzeFailureStream(
        caseKey,
        force,
        {
          onThinking: (text) => {
            if (isCurrent()) setThinkingText((prev) => prev + text)
          },
          onDelta: (text) => {
            if (isCurrent()) setStreamText((prev) => prev + text)
          },
          onDone: (result) => {
            if (!isCurrent()) return
            setAnalysis(result)
            // 回调供父组件缓存
            if (onAnalysisDone) {
              onAnalysisDone(caseKey, result)
            }
          },
          onError: (message) => {
            if (isCurrent()) setError(message)
          },
        },
        controller.signal,
      )
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        setError(err?.message || '分析失败')
      }
    } finally {
      // 只有仍是当前请求时才收尾，避免旧请求覆盖新请求状态
      if (abortRef.current === controller) {
        abortRef.current = null
        setLoading(false)
      }
    }
  }, [testCase, onAnalysisDone])

  // 组件卸载时中断流
  useEffect(() => () => abortRef.current?.abort(), [])

  // 流式文本自动滚动到底部
  useEffect(() => {
    const el = streamRef.current
    if (el) el.scrollTop = el.scrollHeight
    const thinkingEl = thinkingRef.current
    if (thinkingEl) thinkingEl.scrollTop = thinkingEl.scrollHeight
  }, [streamText, thinkingText])

  // 打开时如果没有缓存，自动触发分析
  useEffect(() => {
    if (open && testCase && !cachedAnalysis && !analysis && !error && !loading) {
      doAnalyze()
    }
  }, [open, testCase, cachedAnalysis, analysis, error, loading, doAnalyze])

  const cat = analysis ? CATEGORY_MAP[analysis.root_cause_category] : null

  // 流式查看时隐藏 JSON 代码围栏
  const displayStreamText = streamText
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')

  return (
    <Drawer
      title={
        <Space>
          <BulbOutlined />
          <span>AI 失败分析</span>
          {testCase && <Tag>{testCase.case_id}</Tag>}
        </Space>
      }
      open={open}
      onClose={onClose}
      width={520}
      extra={
        analysis && (
          <Button
            icon={<ReloadOutlined />}
            size="small"
            onClick={() => doAnalyze(true)}
            loading={loading}
          >
            重新分析
          </Button>
        )
      }
    >
      {!testCase ? (
        <Empty description="未选择用例" />
      ) : loading ? (
        streamText || thinkingText ? (
          <div>
            {thinkingText && (
              <details
                open={!streamText}
                style={{ marginBottom: streamText ? 12 : 0 }}
              >
                <summary style={{ cursor: 'pointer', fontSize: 12, color: '#8c8c8c' }}>
                  模型思考过程（{thinkingText.length} 字符）
                </summary>
                <div
                  ref={thinkingRef}
                  style={{
                    maxHeight: streamText ? 160 : '50vh',
                    overflowY: 'auto',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    fontSize: 12,
                    lineHeight: 1.6,
                    color: '#8c8c8c',
                    background: '#fafafa',
                    padding: 10,
                    borderRadius: 6,
                    marginTop: 6,
                  }}
                >
                  {thinkingText}
                </div>
              </details>
            )}

            {streamText ? (
              <>
                <Card
                  size="small"
                  title={
                    <Space>
                      <Spin size="small" />
                      <span>AI 正在流式生成分析…</span>
                    </Space>
                  }
                >
                  <div
                    ref={streamRef}
                    style={{
                      maxHeight: '60vh',
                      overflowY: 'auto',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      fontFamily: 'Consolas, Monaco, monospace',
                      fontSize: 12,
                      lineHeight: 1.6,
                      background: '#f5f5f5',
                      padding: 10,
                      borderRadius: 6,
                    }}
                  >
                    {displayStreamText}
                    <span style={{ color: '#1677ff' }}>▌</span>
                  </div>
                </Card>
                <div style={{ marginTop: 8, textAlign: 'right' }}>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    已接收 {streamText.length} 字符，生成完成后自动解析
                  </Text>
                </div>
              </>
            ) : (
              <div style={{ textAlign: 'center', marginTop: 16 }}>
                <Space>
                  <Spin size="small" />
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    AI 正在推理，尚未开始输出…
                  </Text>
                </Space>
              </div>
            )}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '60px 0' }}>
            <Spin size="large" tip="AI 正在分析失败原因..." />
          </div>
        )
      ) : error ? (
        <div>
          <Alert type="error" message="分析失败" description={error} showIcon />
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <Button type="primary" onClick={() => doAnalyze(true)}>重试</Button>
          </div>
        </div>
      ) : analysis ? (
        <div>
          {/* 根因分类 + 置信度 */}
          <Card size="small" style={{ marginBottom: 16 }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space>
                <Tag
                  icon={cat?.icon}
                  color={cat?.color || 'default'}
                  style={{ fontSize: 14, padding: '4px 12px' }}
                >
                  {cat?.label || analysis.root_cause_category}
                </Tag>
                {analysis.is_likely_real_bug && (
                  <Tag color="red" icon={<BugOutlined />}>疑似真实缺陷</Tag>
                )}
                {analysis._from_cache && (
                  <Tag color="default" style={{ fontSize: 11 }}>缓存</Tag>
                )}
              </Space>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>置信度</Text>
                <Progress
                  percent={Math.round(analysis.confidence * 100)}
                  size="small"
                  strokeColor={
                    analysis.confidence >= 0.8 ? '#52c41a'
                    : analysis.confidence >= 0.6 ? '#faad14'
                    : '#ff4d4f'
                  }
                />
              </div>
            </Space>
          </Card>

          {/* 根因摘要 */}
          <Descriptions column={1} size="small" bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label="根因摘要">
              <Text strong>{analysis.root_cause_summary}</Text>
            </Descriptions.Item>
          </Descriptions>

          {/* 详细分析 */}
          <Title level={5}>详细分析</Title>
          <Paragraph style={{ whiteSpace: 'pre-wrap', fontSize: 13, background: '#f5f5f5', padding: 12, borderRadius: 6 }}>
            {analysis.explanation}
          </Paragraph>

          {/* 证据 */}
          {analysis.evidence && analysis.evidence.length > 0 && (
            <>
              <Divider style={{ margin: '12px 0' }} />
              <Title level={5}>
                <CheckCircleOutlined style={{ marginRight: 6 }} />
                关键证据
              </Title>
              <List
                size="small"
                bordered
                dataSource={analysis.evidence}
                renderItem={(item) => (
                  <List.Item>
                    <Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>{item}</Text>
                  </List.Item>
                )}
              />
            </>
          )}

          {/* 修复建议 */}
          {analysis.suggestion && analysis.suggestion.length > 0 && (
            <>
              <Divider style={{ margin: '12px 0' }} />
              <Title level={5}>
                <BulbOutlined style={{ marginRight: 6 }} />
                修复建议
              </Title>
              <List
                size="small"
                dataSource={analysis.suggestion}
                renderItem={(item, idx) => (
                  <List.Item>
                    <Text>{idx + 1}. {item}</Text>
                  </List.Item>
                )}
              />
            </>
          )}

          {/* 元信息 */}
          {(analysis._model || analysis._tokens) && (
            <>
              <Divider style={{ margin: '12px 0' }} />
              <Space style={{ fontSize: 11 }}>
                {analysis._model && <Tag color="default">{analysis._model}</Tag>}
                {analysis._tokens && <Text type="secondary">{analysis._tokens} tokens</Text>}
              </Space>
            </>
          )}
        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: '60px 0' }}>
          <Button type="primary" icon={<BulbOutlined />} onClick={() => doAnalyze()}>
            开始 AI 分析
          </Button>
        </div>
      )}
    </Drawer>
  )
}
