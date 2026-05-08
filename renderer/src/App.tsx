import { HashRouter, Route, Routes } from 'react-router-dom';
import ProjectManager from './pages/ProjectManager';
import ProjectWorkspace from './pages/ProjectWorkspace';

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<ProjectManager />} />
        <Route path="/project/:projectId" element={<ProjectWorkspace />} />
      </Routes>
    </HashRouter>
  );
}
