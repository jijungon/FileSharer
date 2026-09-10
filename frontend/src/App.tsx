import { Navigate, Route, Routes } from 'react-router-dom'
import Files from './pages/Files'
import Login from './pages/Login'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/files" element={<Files />} />
      <Route path="*" element={<Navigate to="/files" replace />} />
    </Routes>
  )
}
