using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
namespace MoaCapture;

public static class Theme
{
    public static readonly Brush Accent = new SolidColorBrush(Color.FromRgb(113, 97, 232));
    public static readonly Brush Text = new SolidColorBrush(Color.FromRgb(44, 49, 68));
    public static readonly Brush Muted = new SolidColorBrush(Color.FromRgb(103, 115, 139));
    public static readonly Brush Line = new SolidColorBrush(Color.FromRgb(224, 229, 239));
    public static TextBlock Label(string text, double size = 14, bool bold = false) => new() { Text = text, FontSize = size, FontWeight = bold ? FontWeights.SemiBold : FontWeights.Normal, Foreground = Text, TextWrapping = TextWrapping.Wrap };
    public static Button Button(string label, bool primary = false)
    {
        var button = new Button { Content = label, MinHeight = 40, Padding = new Thickness(15, 9, 15, 9), Margin = new Thickness(0, 0, 9, 0), FontSize = 14, FontWeight = FontWeights.SemiBold, Foreground = primary ? Brushes.White : Text, Background = primary ? Accent : Brushes.White, BorderBrush = primary ? Accent : Line, BorderThickness = new Thickness(1), Cursor = System.Windows.Input.Cursors.Hand };
        var border = new FrameworkElementFactory(typeof(Border));
        border.SetValue(Border.CornerRadiusProperty, new CornerRadius(8));
        border.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = new(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        border.SetBinding(Border.BorderBrushProperty, new System.Windows.Data.Binding("BorderBrush") { RelativeSource = new(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        border.SetBinding(Border.BorderThicknessProperty, new System.Windows.Data.Binding("BorderThickness") { RelativeSource = new(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        var content = new FrameworkElementFactory(typeof(ContentPresenter));
        content.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
        content.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
        content.SetBinding(ContentPresenter.MarginProperty, new System.Windows.Data.Binding("Padding") { RelativeSource = new(System.Windows.Data.RelativeSourceMode.TemplatedParent) });
        border.AppendChild(content);
        var template = new ControlTemplate(typeof(Button)) { VisualTree = border };
        var hover = new Trigger { Property = UIElement.IsMouseOverProperty, Value = true };
        hover.Setters.Add(new Setter(UIElement.OpacityProperty, .88));
        template.Triggers.Add(hover);
        button.Template = template;
        return button;
    }
    public static TextBox TextBox(string text, bool multiline = false) => new() { Text = text, FontSize = 15, Foreground = Text, Background = Brushes.White, BorderBrush = Line, BorderThickness = new Thickness(1), Padding = new Thickness(11), AcceptsReturn = multiline, TextWrapping = multiline ? TextWrapping.Wrap : TextWrapping.NoWrap, VerticalScrollBarVisibility = multiline ? ScrollBarVisibility.Auto : ScrollBarVisibility.Hidden };
}
