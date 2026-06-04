import { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import {
  Bold as BoldIcon,
  Italic as ItalicIcon,
  Underline as UnderlineIcon,
  List as ListIcon,
  ListOrdered as ListOrderedIcon,
  Link as LinkIcon,
  Unlink as UnlinkIcon,
  Undo2,
  Redo2,
} from 'lucide-react';

/**
 * Small TipTap-based rich-text editor. Outputs HTML — designed for fields
 * that get pushed to channels like Wix that expect simple HTML markup.
 *
 * Props:
 *   value       — current HTML string
 *   onChange    — called with the new HTML on every keystroke
 *   disabled    — disables editing AND the toolbar
 *   placeholder — shown when empty
 *   minRows     — minimum visible rows (controls min-height)
 */
export default function RichTextEditor({
  value,
  onChange,
  disabled = false,
  placeholder = '',
  minRows = 4,
}) {
  const editor = useEditor({
    extensions: [
      // We keep the editor light: no headings/blockquotes/codeblocks —
      // Wix's product description fields don't expect them. StarterKit v3
      // already bundles Link and Underline, so we disable its defaults and
      // register configured versions below to avoid duplicate-name warnings.
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
        code: false,
        strike: false,
        link: false,
        underline: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer' },
      }),
      Placeholder.configure({ placeholder }),
    ],
    content: value || '',
    editable: !disabled,
    onUpdate: ({ editor: ed }) => {
      // TipTap returns "<p></p>" for an empty doc — normalize to '' so the
      // dirty-detector and the patch builder treat empty as null.
      const html = ed.getHTML();
      onChange(html === '<p></p>' ? '' : html);
    },
    editorProps: {
      attributes: {
        class: 'prose-content focus:outline-none px-3 py-2 text-body-md text-on-surface',
        style: `min-height: ${minRows * 1.5}rem;`,
      },
    },
  });

  // Reseed the editor when the value changes externally (e.g. Pull from Wix
  // overwrites the form). Skip if the editor already has this HTML, otherwise
  // every keystroke would re-set the content and reset the cursor.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    const incoming = value || '';
    if (current === incoming || (current === '<p></p>' && incoming === '')) return;
    editor.commands.setContent(incoming, false);
  }, [value, editor]);

  // Keep editable state in sync when `disabled` flips at runtime.
  useEffect(() => {
    if (editor) editor.setEditable(!disabled);
  }, [disabled, editor]);

  if (!editor) {
    // Render a placeholder during the initial mount so the layout is stable.
    return (
      <div
        className="rounded-lg border border-outline-variant bg-surface-container-low/50"
        style={{ minHeight: `${minRows * 1.5 + 3}rem` }}
      />
    );
  }

  function handleSetLink() {
    const prev = editor.getAttributes('link').href;
    const url = window.prompt('Link URL (leave empty to remove)', prev ?? '');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  }

  return (
    <div
      className={`rounded-lg border border-outline-variant bg-surface overflow-hidden focus-within:ring-2 focus-within:ring-primary/30 focus-within:border-primary transition-colors ${
        disabled ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-center gap-0.5 px-2 py-1 border-b border-outline-variant bg-surface-container-low/60 flex-wrap">
        <ToolbarBtn
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
          disabled={disabled}
          title="Bold (Ctrl+B)"
        >
          <BoldIcon className="w-3.5 h-3.5" />
        </ToolbarBtn>
        <ToolbarBtn
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          disabled={disabled}
          title="Italic (Ctrl+I)"
        >
          <ItalicIcon className="w-3.5 h-3.5" />
        </ToolbarBtn>
        <ToolbarBtn
          active={editor.isActive('underline')}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
          disabled={disabled}
          title="Underline (Ctrl+U)"
        >
          <UnderlineIcon className="w-3.5 h-3.5" />
        </ToolbarBtn>

        <Divider />

        <ToolbarBtn
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          disabled={disabled}
          title="Bullet list"
        >
          <ListIcon className="w-3.5 h-3.5" />
        </ToolbarBtn>
        <ToolbarBtn
          active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          disabled={disabled}
          title="Numbered list"
        >
          <ListOrderedIcon className="w-3.5 h-3.5" />
        </ToolbarBtn>

        <Divider />

        <ToolbarBtn
          active={editor.isActive('link')}
          onClick={handleSetLink}
          disabled={disabled}
          title="Insert / edit link"
        >
          <LinkIcon className="w-3.5 h-3.5" />
        </ToolbarBtn>
        {editor.isActive('link') && (
          <ToolbarBtn
            onClick={() => editor.chain().focus().unsetLink().run()}
            disabled={disabled}
            title="Remove link"
          >
            <UnlinkIcon className="w-3.5 h-3.5" />
          </ToolbarBtn>
        )}

        <div className="flex-1" />

        <ToolbarBtn
          onClick={() => editor.chain().focus().undo().run()}
          disabled={disabled || !editor.can().undo()}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 className="w-3.5 h-3.5" />
        </ToolbarBtn>
        <ToolbarBtn
          onClick={() => editor.chain().focus().redo().run()}
          disabled={disabled || !editor.can().redo()}
          title="Redo (Ctrl+Shift+Z)"
        >
          <Redo2 className="w-3.5 h-3.5" />
        </ToolbarBtn>
      </div>

      <EditorContent editor={editor} />
    </div>
  );
}

function ToolbarBtn({ active, onClick, disabled, title, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`p-1.5 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
        active
          ? 'bg-primary text-on-primary'
          : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface'
      }`}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="w-px h-4 bg-outline-variant mx-1 self-center" />;
}
