import { Routes, Route, Navigate } from 'react-router-dom'
import { AnimatePresence } from 'framer-motion'
import { usePipelineStore } from './store/pipelineStore'
import Layout from './components/Layout'
import StorySelect from './pages/StorySelect'
import Projects from './pages/Projects'
import SceneImages from './pages/SceneImages'
import VideoGeneration from './pages/VideoGeneration'
import AudioGeneration from './pages/AudioGeneration'
import EditorTimeline from './pages/EditorTimeline'
import Export from './pages/Export'

function App() {
  const { selectedStory, selectedImages, selectedVideos } = usePipelineStore()
  
  return (
    <Layout>
      <AnimatePresence mode="wait">
        <Routes>
          <Route path="/" element={<StorySelect />} />
          {/* Projects browser — always accessible, no step gating */}
          <Route path="/projects" element={<Projects />} />
          {/* Audio comes right after the story — its measured durations drive
              how many images/videos each scene needs */}
          <Route
            path="/audio"
            element={selectedStory ? <AudioGeneration /> : <Navigate to="/" replace />}
          />
          <Route
            path="/images"
            element={selectedStory ? <SceneImages /> : <Navigate to="/" replace />}
          />
          <Route
            path="/videos"
            element={
              selectedStory && Object.keys(selectedImages).length > 0
                ? <VideoGeneration />
                : <Navigate to="/" replace />
            }
          />
          {/* Editor — studio timeline between Videos and Export */}
          <Route
            path="/editor"
            element={
              selectedStory && Object.keys(selectedVideos).length > 0
                ? <EditorTimeline />
                : <Navigate to="/" replace />
            }
          />
          <Route
            path="/metadata"
            element={
              selectedStory && Object.keys(selectedVideos).length > 0
                ? <Export />
                : <Navigate to="/" replace />
            }
          />
          <Route
            path="/export"
            element={
              selectedStory && Object.keys(selectedVideos).length > 0
                ? <Export />
                : <Navigate to="/" replace />
            }
          />
        </Routes>
      </AnimatePresence>
    </Layout>
  )
}

export default App
