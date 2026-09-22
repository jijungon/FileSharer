import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

// 렌더/라이프사이클에서 던져진 에러를 잡아 흰 화면(WSOD) 대신 복구 UI를 보여준다.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h1>⚠️ 문제가 발생했어요</h1>
          <p className="muted">화면을 그리는 중 오류가 났습니다. 새로고침하면 대부분 해결됩니다.</p>
          <pre className="error-boundary-detail">{this.state.error.message}</pre>
          <div className="error-boundary-actions">
            <button className="btn-primary" onClick={() => window.location.reload()}>
              새로고침
            </button>
            <button className="btn-utility" onClick={() => this.setState({ error: null })}>
              다시 시도
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
