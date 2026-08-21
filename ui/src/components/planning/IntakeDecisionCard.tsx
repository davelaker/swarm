import { useId, useState } from 'react';
import {
  EXECUTION_SHAPE_DESCRIPTIONS,
  EXECUTION_SHAPE_LABELS,
  EXECUTION_SHAPES,
  INTAKE_CONFIDENCE_LABELS,
  INTAKE_RISK_SIGNAL_LABELS,
  type ExecutionShape,
  type IntakeDecision,
} from '../../data/intake';
import { IconChevron, IconX } from '../common/icons';
import './IntakeDecisionCard.css';

interface IntakeDecisionCardProps {
  decision: IntakeDecision;
  onAccept: (decision: IntakeDecision) => void;
  onChooseShape: (shape: ExecutionShape) => void;
  onDismiss: () => void;
}

export function IntakeDecisionCard({
  decision,
  onAccept,
  onChooseShape,
  onDismiss,
}: IntakeDecisionCardProps) {
  const [choicesOpen, setChoicesOpen] = useState(false);
  const titleId = useId();
  const choicesId = useId();
  const recommendation = EXECUTION_SHAPE_LABELS[decision.shape];

  return (
    <section className="intake-card" aria-labelledby={titleId}>
      <div className="intake-card-head">
        <div>
          <p className="intake-card-kicker">Recommended workflow</p>
          <h2 id={titleId}>{recommendation}</h2>
        </div>
        <div className="intake-card-meta">
          <span className={`intake-confidence ${decision.confidence}`}>
            {INTAKE_CONFIDENCE_LABELS[decision.confidence]}
          </span>
          <button
            type="button"
            className="intake-icon-button"
            onClick={onDismiss}
            title="Dismiss recommendation"
            aria-label="Dismiss recommendation"
          >
            <IconX />
          </button>
        </div>
      </div>

      <p className="intake-card-rationale">{decision.rationale}</p>
      <p className="intake-card-action">{decision.suggestedAction}</p>

      {decision.riskSignals.length > 0 && (
        <div className="intake-risks" aria-label="Risk signals">
          {decision.riskSignals.map(signal => (
            <span key={signal}>{INTAKE_RISK_SIGNAL_LABELS[signal]}</span>
          ))}
        </div>
      )}

      <div className="intake-actions">
        <button type="button" className="btn primary" onClick={() => onAccept(decision)}>
          Use {recommendation}
        </button>
        <button
          type="button"
          className="intake-choice-toggle"
          onClick={() => setChoicesOpen(open => !open)}
          aria-expanded={choicesOpen}
          aria-controls={choicesId}
        >
          Choose another
          <span className={choicesOpen ? 'open' : ''} aria-hidden="true">
            <IconChevron />
          </span>
        </button>
      </div>

      {choicesOpen && (
        <div id={choicesId} className="intake-choice-list">
          {EXECUTION_SHAPES.map(shape => (
            <button
              type="button"
              key={shape}
              className={shape === decision.shape ? 'selected' : ''}
              onClick={() => onChooseShape(shape)}
              aria-pressed={shape === decision.shape}
            >
              <span>{EXECUTION_SHAPE_LABELS[shape]}</span>
              <small>{EXECUTION_SHAPE_DESCRIPTIONS[shape]}</small>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
