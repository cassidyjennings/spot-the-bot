import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { DisplayApp } from './display';
import { InstructorApp } from './instructor';
import { StudentApp } from './student';
import './style.css';

// Hash routes, because GitHub Pages has no SPA fallback: #/ (students), #/instructor, #/display?s=<id>
function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function App() {
  const hash = useHash();
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  if (path.startsWith('/instructor')) return <InstructorApp />;
  if (path.startsWith('/display')) return <DisplayApp sid={new URLSearchParams(query).get('s')} />;
  return <StudentApp />;
}

render(<App />, document.getElementById('app')!);
