import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../lib/api';

export default function Report() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const source = api.report(id);

  const download = () => {
    if (source.downloadUrl) return; // anchor handles it
    // Mock mode: build a blob from the inline document.
    const blob = new Blob([source.srcdoc ?? ''], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `debate-report-${id}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="report-page">
      <div className="report-bar">
        <button className="btn sm" onClick={() => nav(`/debate/${id}`)}>
          Back to the room
        </button>
        <span className="uplabel bright">Final report</span>
        <div className="hud-spacer" />
        {source.downloadUrl ? (
          <a className="btn sm outline-cyan" href={source.downloadUrl} download={`debate-report-${id}.html`}>
            Download
          </a>
        ) : (
          <button className="btn sm outline-cyan" onClick={download}>
            Download
          </button>
        )}
      </div>
      {source.src ? (
        <iframe className="report-frame" src={source.src} title="Debate report" />
      ) : (
        <iframe className="report-frame" srcDoc={source.srcdoc} title="Debate report" />
      )}
    </div>
  );
}
