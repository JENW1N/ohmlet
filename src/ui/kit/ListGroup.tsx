/**
 * ListGroup — iOS inset-grouped list container: a glass card with an
 * optional uppercase header above and a footnote below. Fill it with
 * <ListRow>s; separators between rows are drawn by the rows themselves.
 *
 * Usage:
 *   <ListGroup header="Simulation">
 *     <ListRow title="Speed" trailing={<Segmented ... />} />
 *     <ListRow title="Reset" destructive onPress={reset} />
 *   </ListGroup>
 */
import type { ReactNode } from 'react'

export interface ListGroupProps {
  children: ReactNode
  /** Uppercase caption above the card. */
  header?: ReactNode
  /** Footnote caption below the card. */
  footer?: ReactNode
  className?: string
}

export function ListGroup({ children, header, footer, className }: ListGroupProps) {
  return (
    <section className={`lg-listgroup ${className ?? ''}`}>
      {header != null && <div className="lg-list-header lg-caption">{header}</div>}
      <div className="lg-surface lg-list" role="list">
        {children}
      </div>
      {footer != null && <div className="lg-list-footer lg-caption">{footer}</div>}
    </section>
  )
}
