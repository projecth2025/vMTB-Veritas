import { Bold, Italic, List, Heading3 } from 'lucide-react';

interface EditorToolbarProps {
  onFormat: (command: string, value?: string) => void;
}

export function EditorToolbar({ onFormat }: EditorToolbarProps) {
  const handleFormat = (command: string, value?: string) => {
    onFormat(command, value);
  };

  return (
    <div className="flex items-center space-x-2 p-2 bg-gray-100 border border-gray-300 rounded-t-md">
      <button
        type="button"
        onClick={() => handleFormat('bold')}
        className="p-2 hover:bg-gray-200 rounded transition-colors"
        title="Bold (Ctrl+B)"
      >
        <Bold className="w-4 h-4 text-gray-700" />
      </button>
      
      <button
        type="button"
        onClick={() => handleFormat('italic')}
        className="p-2 hover:bg-gray-200 rounded transition-colors"
        title="Italic (Ctrl+I)"
      >
        <Italic className="w-4 h-4 text-gray-700" />
      </button>
      
      <div className="w-px h-6 bg-gray-300" />
      
      <button
        type="button"
        onClick={() => handleFormat('formatBlock', 'h2')}
        className="p-2 hover:bg-gray-200 rounded transition-colors"
        title="Heading 2"
      >
        <Heading3 className="w-4 h-4 text-gray-700" />
      </button>
      
      <button
        type="button"
        onClick={() => handleFormat('formatBlock', 'h3')}
        className="px-2 py-1 hover:bg-gray-200 rounded transition-colors text-sm font-medium text-gray-700"
        title="Heading 3"
      >
        H3
      </button>
      
      <div className="w-px h-6 bg-gray-300" />
      
      <button
        type="button"
        onClick={() => handleFormat('insertUnorderedList')}
        className="p-2 hover:bg-gray-200 rounded transition-colors"
        title="Bullet List"
      >
        <List className="w-4 h-4 text-gray-700" />
      </button>
      
      <button
        type="button"
        onClick={() => handleFormat('insertOrderedList')}
        className="px-2 py-1 hover:bg-gray-200 rounded transition-colors text-sm font-medium text-gray-700"
        title="Numbered List"
      >
        1-2-3
      </button>
    </div>
  );
}
