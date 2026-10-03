import { useEffect, useRef } from 'react';
import { createJSONEditor, Mode, type Content, type JsonEditor, type MenuItem } from 'vanilla-jsoneditor';

interface JSONInputProps {
  text: string;
  onChange?: (text: string) => void;
  readOnly?: boolean;
  // Sizing for the editor's container; the default fixed height suits the
  // modal and form uses, while the credential detail view stretches it to
  // match the panel beside it.
  className?: string;
}

// A JSON text editor with dynamic error checking and highlighting, after
// exchange-ui's JSONInput: vanilla-jsoneditor in text mode, wrapped for React.
export default function JSONInput({ text, onChange, readOnly = false, className = 'h-64' }: JSONInputProps) {
  const refContainer = useRef<HTMLDivElement>(null);
  const refEditor = useRef<JsonEditor | null>(null);
  // Tracks the editor's own text so external updates (a staged file) can be
  // told apart from the editor echoing the user's typing back through state.
  const lastEditorText = useRef(text);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    refEditor.current = createJSONEditor({
      target: refContainer.current!,
      props: {
        mode: Mode.text,
        readOnly,
        content: { text: lastEditorText.current },
        onRenderMenu: (items: MenuItem[]) =>
          items.filter(
            (item: MenuItem) =>
              !('text' in item && item.text === 'table') &&
              !('className' in item && ['jse-transform', 'jse-sort'].includes(item.className ?? ''))
          ),
        onChange: (content: Content) => {
          const updated = 'text' in content ? content.text : JSON.stringify(content.json, null, 2);
          lastEditorText.current = updated;
          onChangeRef.current?.(updated);
        }
      }
    });

    return () => {
      refEditor.current?.destroy();
      refEditor.current = null;
    };
  }, []);

  useEffect(() => {
    if (refEditor.current && text !== lastEditorText.current) {
      lastEditorText.current = text;
      refEditor.current.updateProps({ content: { text } });
    }
  }, [text]);

  return <div ref={refContainer} className={`${className} overflow-hidden rounded-lg border border-gray-300`} />;
}
