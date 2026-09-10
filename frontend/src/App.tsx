import { Navigate, Route, Routes } from 'react-router-dom'
import Admin from './pages/Admin'
import Files from './pages/Files'
import Login from './pages/Login'
import Share from './pages/Share'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/files" element={<Files />} />
      <Route path="/files/:nodeId" element={<Files />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="/s/:token" element={<Share />} />
      <Route path="*" element={<Navigate to="/files" replace />} />
    </Routes>
  )
}
